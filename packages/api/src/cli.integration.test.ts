import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@standfast/cli";
import { closePool, generateApiKey } from "@standfast/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * Drives the real CLI against the real API.
 *
 * The unit tests in packages/cli prove the argument handling and the
 * credential file. They cannot prove a command actually works, because that
 * needs a server — so it is proven here, where one exists. The CLI's fetch is
 * injected into the Hono app, so no socket is involved.
 *
 * Here rather than in packages/cli because of the licence direction: this
 * package is AGPL-3.0 and may depend on the Apache-2.0 CLI. The reverse would
 * contaminate a package that ships to users' machines.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();
const fetchIntoApp = ((input: Request) =>
  app.request(input)) as typeof globalThis.fetch;

let home = "";
let workdir = "";
let projectId = "";

const originalXdg = process.env["XDG_CONFIG_HOME"];
const originalKey = process.env["STANDFAST_API_KEY"];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "standfast-e2e-home-"));
  workdir = await mkdtemp(join(tmpdir(), "standfast-e2e-work-"));
  process.env["XDG_CONFIG_HOME"] = home;

  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE standfast_test LOGIN PASSWORD 'standfast_test' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query('GRANT "standfast_app" TO standfast_test');

    const suffix = `${Date.now()}-${process.pid}`;
    const org = await db.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $1) returning id",
      [`cli-${suffix}`],
    );
    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', 'h') returning id",
      [org.rows[0]?.id],
    );

    // Production creates this with the org (bootstrap.ts, migration 0004), so a
    // test that creates an org creates one too. putDocument resolves it to
    // attribute extraction jobs, and deliberately refuses to mint one itself.
    await db.query(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor')",
      [org.rows[0]?.id],
    );
    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [
        org.rows[0]?.id,
        actor.rows[0]?.id,
        `${generated.prefix}-${suffix}`,
        generated.hash,
      ],
    );
    // Environment beats the config file, which is what lets CI run without
    // writing a credential to disk.
    process.env["STANDFAST_API_KEY"] = generated.key;
  } finally {
    await db.end();
  }

  const url = new URL(adminUrl);
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
  if (originalXdg === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdg;
  }
  if (originalKey === undefined) {
    delete process.env["STANDFAST_API_KEY"];
  } else {
    process.env["STANDFAST_API_KEY"] = originalKey;
  }
});

const cli = (...argv: string[]) => run(argv, { fetch: fetchIntoApp });

describe("standfast end to end", () => {
  it("verifies the credential with whoami", async () => {
    expect(await cli("whoami")).toBe(0);
  });

  it("creates a project and lists it", async () => {
    expect(
      await cli("project", "create", "CLI Test", "--slug", `cli-${Date.now()}`),
    ).toBe(0);
    expect(await cli("project", "ls")).toBe(0);

    // Recover the id the way a user would: read it back through the API.
    const res = await app.request("/v1/projects", {
      headers: { authorization: `Bearer ${process.env["STANDFAST_API_KEY"]}` },
    });
    const projects = (await res.json()) as { items: { id: string }[] };
    projectId = projects.items[0]?.id ?? "";
    expect(projectId).not.toBe("");
  });

  it("pushes a markdown file and lists it", async () => {
    const file = join(workdir, "notes.md");
    await writeFile(file, "# Rule\nAlways ship.\n\n# Second\nMore.", "utf8");

    expect(
      await cli(
        "doc",
        "push",
        file,
        "--project",
        projectId,
        "--path",
        "docs/notes.md",
      ),
    ).toBe(0);
    expect(await cli("doc", "ls", "--project", projectId)).toBe(0);
  });

  // Absolute local paths would ship the operator's home directory to the
  // server and cannot be reconstructed by export.
  it("refuses a file outside the working directory without --path", async () => {
    const stray = join(workdir, "stray.md");
    await writeFile(stray, "# Stray", "utf8");
    expect(await cli("doc", "push", stray, "--project", projectId)).toBe(2);
  });

  it("requires --project rather than guessing", async () => {
    expect(await cli("doc", "ls")).toBe(2);
  });

  // docs/02-principles.md (11): anti-lock-in is only credible if it works
  // before anyone asks for it.
  it("exports every document as markdown the user keeps", async () => {
    const target = join(workdir, "export");
    expect(await cli("export", target)).toBe(0);

    const projects = await readdir(target);
    expect(projects.length).toBeGreaterThan(0);

    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          found.push(full);
        }
      }
    };
    await walk(target);

    expect(found.length).toBeGreaterThan(0);
    const body = await readFile(found[0] ?? "", "utf8");
    expect(body).toContain("Always ship.");
  });

  it("answers the egress question, and says so when nothing left", async () => {
    // The pipeline has not run here, so the honest answer is that nothing has
    // left — and a self-hosted deployment on local models should get that same
    // answer forever. It has to read as a statement, not as an empty table.
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cli("egress", "--project", projectId)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join("")).toContain("Nothing has left this project.");
  });

  it("emits parseable JSON with --json", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await cli("project", "ls", "--json")).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(() => JSON.parse(chunks.join(""))).not.toThrow();
  });
});
