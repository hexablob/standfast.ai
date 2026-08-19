import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adminUrl, ensureTestRole, installQueue } from "@standfast/db/testing";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The start-up guard, asserted against the real binary.
 *
 * docs/13-threat-model.md listed this as one of two mechanisms nothing tested.
 * It is worth spawning a process for, because a guard that only exists in a
 * module the tests import is a guard that a refactor can lift out of the
 * entrypoint without anything noticing.
 */
describe("the worker process", () => {
  beforeAll(async () => {
    await ensureTestRole();
    await installQueue(adminUrl());
  }, 60_000);

  async function start(env: Record<string, string>): Promise<string> {
    try {
      const { stderr } = await run(process.execPath, ["dist/main.js"], {
        cwd: new URL("../", import.meta.url).pathname,
        env: { ...process.env, ...env },
        timeout: 20_000,
      });
      return `EXITED CLEANLY: ${stderr}`;
    } catch (error) {
      const e = error as { stderr?: string; message?: string };
      return e.stderr ?? e.message ?? "";
    }
  }

  it("refuses to consume the queue on a superuser connection", async () => {
    // Not a degraded mode. A worker with no tenant isolation looks entirely
    // healthy and writes atoms into whichever org a job payload names.
    const said = await start({ DATABASE_URL: adminUrl() });
    expect(said).toMatch(/superuser|BYPASSRLS|row-level security/i);
  }, 40_000);

  it("refuses a configuration the egress allowlist does not admit", async () => {
    // Asserted against the real binary rather than resolvePorts, because the
    // control only counts if it sits on the process's start-up path — a
    // refactor can lift a check out of an entrypoint and every unit test still
    // passes.
    const url = new URL(adminUrl());
    url.username = "standfast_test";
    url.password = "standfast_test";

    // A real embedder with fake everything else: half-working, which is worse
    // than not working.
    const mixed = await start({
      DATABASE_URL: url.toString(),
      STANDFAST_EMBEDDING_MODEL: "voyage-3",
    });
    expect(mixed).toMatch(/mixed configuration/);

    // All three real, and nothing on the allowlist: the destination is not
    // called, and the refusal is here rather than at the first job.
    const unlisted = await start({
      DATABASE_URL: url.toString(),
      STANDFAST_EXTRACTION_PROMPT_VERSION: "p1",
      STANDFAST_EXTRACTION_MODEL: "claude-opus-5",
      STANDFAST_EMBEDDING_MODEL: "voyage-3",
      STANDFAST_JUDGE_MODEL: "claude-sonnet-5",
      ANTHROPIC_API_KEY: "unused",
      VOYAGE_API_KEY: "unused",
    });
    expect(unlisted).toMatch(/no egress allowlist entry for extraction/);
  }, 60_000);
});
