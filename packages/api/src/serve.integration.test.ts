import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The start-up refusal, driven through the process that actually starts.
 *
 * `packages/db` already proves `assertTenantIsolationApplies` throws when the
 * role holds BYPASSRLS. What that leaves open — and what
 * `docs/13-threat-model.md` asked for verbatim — is the `await` in
 * `serve.ts`: whether the rejection reaches the top of a real process, before
 * `serve()` is called, and takes the process down instead of being logged
 * while the port opens anyway. A throwing function above a `serve()` that ran
 * regardless would pass the unit test and serve every org's rows to everyone.
 *
 * So this spawns the built entry point — the one `scripts/e2e.sh` runs — at a
 * BYPASSRLS login role and watches for three things: a non-zero exit, the
 * refusal on stderr, and nothing listening on the port.
 */

// Deliberately not the role `packages/db/src/testing/guard.integration.test.ts`
// creates. That suite drops its role in `afterAll`, and two suites sharing one
// name is a failure that only appears when the runner stops being sequential.
const BYPASS_ROLE = "standfast_api_bypassrls_test";
const BYPASS_PASSWORD = "standfast_api_bypassrls_test";

// Not 38080: that is `scripts/e2e.sh`'s.
const PORT = 38099;

const SERVE_ENTRY = fileURLToPath(new URL("../dist/serve.js", import.meta.url));
const built = existsSync(SERVE_ENTRY);

if (!built) {
  process.stderr.write(
    `[serve.integration] ${SERVE_ENTRY} is absent, so the start-up refusal is NOT being tested. Run \`pnpm exec tsc -b\` first.\n`,
  );
}

let adminUrl = "";

function bypassUrl(): string {
  const url = new URL(adminUrl);
  url.username = BYPASS_ROLE;
  url.password = BYPASS_PASSWORD;
  return url.toString();
}

/** Resolves true when nothing accepts a connection on the port. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(2_000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(true));
  });
}

type Exit = { code: number | null; stderr: string };

function runServer(databaseUrl: string): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE_ENTRY], {
      env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // If the guard ever regressed the process would bind the port and stay up,
    // so a test with no deadline would be a test that hangs rather than fails.
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`serve.js was still running after 20s:\n${stderr}`));
    }, 20_000);

    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, stderr });
    });
  });
}

describe.skipIf(!built)("serve.ts on a BYPASSRLS role", () => {
  beforeAll(async () => {
    adminUrl = process.env["DATABASE_URL"] ?? "";
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      // The one role in this repository that holds BYPASSRLS on purpose: it
      // exists to be refused, and it is dropped again below.
      await admin.query(`DO $$ BEGIN
        CREATE ROLE ${BYPASS_ROLE} LOGIN PASSWORD '${BYPASS_PASSWORD}' BYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;`);
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${BYPASS_ROLE}`);
    } finally {
      await admin.end();
    }
  });

  it("exits non-zero without binding the port", async () => {
    expect(await portIsFree(PORT)).toBe(true);

    const { code, stderr } = await runServer(bypassUrl());

    expect(code).not.toBe(0);
    expect(stderr).toContain("Refusing to start");
    expect(stderr).toMatch(/bypasses row-level security/);
    // The line `serve()`'s callback writes. Its absence is the assertion that
    // the refusal happened before the listener, not alongside it.
    expect(stderr).not.toMatch(/listening on/);
    expect(await portIsFree(PORT)).toBe(true);
  }, 30_000);
});
