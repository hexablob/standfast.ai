import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool } from "../client.js";
import {
  getBoss,
  QUEUE_SCHEMA,
  SECTION_EXTRACT_QUEUE,
  stopBoss,
  superviseQueue,
} from "../queue.js";
import { installQueue } from "../queue-install.js";
import { adminClient, adminUrl, appClient, ensureTestRole } from "./harness.js";

/**
 * The schema version pg-boss 12.27.0 declares for itself.
 *
 * Pinned here for the same reason the OpenAPI artifact is committed: the vendor
 * keeps a ledger, and a number in a diff is how a reviewer sees it move. A
 * pg-boss bump that changes this fails here, where the failure names the cause,
 * rather than at whatever it breaks three steps later.
 */
const PGBOSS_SCHEMA_VERSION = 37;

let admin: Client;
let app: Client;
let boss: PgBoss;

beforeAll(async () => {
  await ensureTestRole();
  await installQueue(adminUrl());

  admin = await adminClient();
  app = await appClient();

  boss = new PgBoss({
    connectionString: adminUrl(),
    schema: QUEUE_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    useListenNotify: false,
  });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: true });
  await app?.end();
  await admin?.end();
});

describe("the queue schema", () => {
  it("declares the version this repository was written against", async () => {
    const declared: { pgboss?: { schema?: number } } = createRequire(
      import.meta.url,
    )("pg-boss/package.json");

    expect(declared.pgboss?.schema).toBe(PGBOSS_SCHEMA_VERSION);
    expect(await boss.schemaVersion()).toBe(PGBOSS_SCHEMA_VERSION);
  });

  it("is installed, and has not drifted from what pg-boss expects", async () => {
    expect(await boss.isInstalled()).toBe(true);

    // pg-boss compares the installed objects against its own construction plan
    // and reports every category of difference. Asserted field by field rather
    // than on `ok` alone, so a future version that adds a category to the report
    // and leaves `ok` true still fails here.
    const drift = await boss.detectSchemaDrift();
    expect(drift).toMatchObject({
      ok: true,
      missing: [],
      missingTables: [],
      missingFunctions: [],
      mismatched: [],
      mismatchedFunctions: [],
      columnDrift: [],
      constraintDrift: [],
      extraIndexes: [],
      invalid: [],
      building: [],
      enumDrift: null,
    });
  });

  it("declares section.extract at install time, not at runtime", async () => {
    const queues = await boss.getQueues();
    expect(queues.map((q: { name: string }) => q.name)).toContain(
      SECTION_EXTRACT_QUEUE,
    );
  });

  it("lets the restricted role work the queue", async () => {
    const before = await app.query<{ n: string }>(
      `select count(*)::text n from "${QUEUE_SCHEMA}"."job" where name = $1`,
      [SECTION_EXTRACT_QUEUE],
    );

    await app.query(
      `insert into "${QUEUE_SCHEMA}"."job" (name, data) values ($1, $2)`,
      [SECTION_EXTRACT_QUEUE, JSON.stringify({ probe: true })],
    );

    const after = await app.query<{ n: string }>(
      `select count(*)::text n from "${QUEUE_SCHEMA}"."job" where name = $1`,
      [SECTION_EXTRACT_QUEUE],
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
  });

  it("does not let the restricted role extend the schema", async () => {
    // A grant nobody attempted to exceed is a grant nobody verified. With
    // CREATE withheld, a createQueue() from a serving process fails rather than
    // quietly succeeding — which is the difference between "queues are declared
    // at install time" and "queues are declared at install time, so far".
    await expect(
      app.query(`create table "${QUEUE_SCHEMA}"."intruder" (i int)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("keeps its tables out of the tenant schema", async () => {
    // The wire-allowlist guard compares against table_schema = 'public'. pg-boss
    // carries no org_id and is not in WIRE_ALLOWLIST; putting its tables in
    // public would ask that guard to have an opinion about a vendor's schema.
    const inPublic = await admin.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('job', 'queue', 'version', 'schedule', 'subscription')`,
    );
    expect(inPublic.rows).toEqual([]);
  });
});

describe("a job whose worker died mid-execution", () => {
  /**
   * Reads a job's state straight out of pg-boss's table. Nothing in the client
   * API distinguishes "still leased by a process that no longer exists" from
   * "being worked on", which is the whole difficulty.
   */
  async function stateOf(id: string): Promise<string | undefined> {
    const { rows } = await admin.query<{ state: string }>(
      `select state from "${QUEUE_SCHEMA}"."job" where id = $1`,
      [id],
    );
    return rows[0]?.state;
  }

  it("stays active until something supervises the queue", async () => {
    const id = await boss.send(
      SECTION_EXTRACT_QUEUE,
      { sectionId: "stranded" },
      // The shortest lease pg-boss allows. In production this is 900s, which is
      // why the failure below takes a quarter of an hour to become visible and
      // is easy to mistake for a slow model call.
      { expireInSeconds: 1 },
    );
    if (!id) throw new Error("send returned no job id");

    // Leased and then abandoned: the shape a killed process leaves behind. No
    // handler ever throws here, so `retryLimit` is never consulted — this is
    // exactly the case retries do not cover. The batch is wide enough to take
    // whatever earlier tests left queued; only this job has a lease short
    // enough to expire during the test.
    await boss.fetch(SECTION_EXTRACT_QUEUE, { batchSize: 50 });
    expect(await stateOf(id)).toBe("active");

    // Not a guess at how long recovery takes: it is the lease elapsing. Past
    // this point the job is over its deadline and nothing is coming for it,
    // because `boss` is a sender and runs no maintenance.
    await delay(1_500);
    expect(await stateOf(id)).toBe("active");

    const supervisor = new PgBoss({
      connectionString: adminUrl(),
      schema: QUEUE_SCHEMA,
      migrate: false,
      createSchema: false,
      useListenNotify: false,
      schedule: false,
      // What `superviseQueue()` turns on in the worker. The two intervals are
      // squeezed only so the test finishes in seconds; both default to 60.
      supervise: true,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      queueCacheIntervalSeconds: 1,
    });
    await supervisor.start();

    try {
      await expect
        .poll(() => stateOf(id), { timeout: 30_000, interval: 250 })
        .not.toBe("active");
    } finally {
      await supervisor.stop({ graceful: true });
    }
  }, 60_000);
});

describe("the process-wide queue handle", () => {
  afterAll(async () => {
    await stopBoss();
    await closePool();
  });

  it("refuses a role declared after the queue is already open", async () => {
    await getBoss();

    // Loudly, because the handle is memoised: the options are fixed at
    // construction, so a later caller getting its way silently is the one
    // outcome that must not be possible.
    expect(() => superviseQueue()).toThrow(/before the queue is opened/);
  });

  it("handles the error event that would otherwise terminate the process", async () => {
    const instance = await getBoss();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      // An EventEmitter rethrows an `error` with no listener, so this call not
      // throwing is the assertion — and in a worker that throw would be death
      // mid-job, which strands the very job supervision exists to recover.
      expect(() =>
        instance.emit("error", new Error("background failure")),
      ).not.toThrow();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
