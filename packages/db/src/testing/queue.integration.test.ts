import { createRequire } from "node:module";
import type { Client } from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_SCHEMA, SECTION_EXTRACT_QUEUE } from "../queue.js";
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
