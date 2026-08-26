import { getTableColumns } from "drizzle-orm";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  atomEvents,
  atoms,
  reconciliationFindings,
  reconciliationRuns,
} from "../schema/knowledge.js";
import {
  NON_TENANT_TABLES,
  TENANT_TABLES,
  WIRE_ALLOWLIST,
} from "../schema/wire-allowlist.js";
import { adminClient } from "./harness.js";

/**
 * The tables this guard reflects over. Phase 3's two, plus `atoms` — which
 * phase 3 altered, and which is the table a composite foreign key now points
 * at.
 */
const SCHEMA_TABLES = {
  atoms,
  atom_events: atomEvents,
  reconciliation_runs: reconciliationRuns,
  reconciliation_findings: reconciliationFindings,
};

let admin: Client;

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  await admin?.end();
});

describe("row-level security is forced, not merely enabled", () => {
  // ENABLE alone lets the table owner bypass every policy. Nothing about the
  // schema looks wrong when FORCE is missing, and a suite that connects as
  // the owner keeps passing — so this is asserted directly against pg_class.
  it.each(TENANT_TABLES)("%s has FORCE ROW LEVEL SECURITY", async (table) => {
    const r = await admin.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      // Namespace-qualified. pg_class spans every schema, so once a second one
      // exists — pgboss, from 0005 — an unqualified relname lookup can return
      // somebody else's row and pass for the wrong reason. The allowlist query
      // below has always been scoped; this one was not.
      `select relrowsecurity, relforcerowsecurity
         from pg_class
        where relname = $1 and relkind = 'r'
          and relnamespace = 'public'::regnamespace`,
      [table],
    );
    expect(r.rows[0]?.relrowsecurity).toBe(true);
    expect(r.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it.each(TENANT_TABLES)("%s has an isolation policy", async (table) => {
    const r = await admin.query(
      "select policyname from pg_policies where schemaname = 'public' and tablename = $1",
      [table],
    );
    expect(r.rowCount).toBeGreaterThan(0);
  });
});

describe("the application role cannot bypass RLS", () => {
  it("standfast_app does not hold BYPASSRLS", async () => {
    const r = await admin.query<{
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      "select rolbypassrls, rolcanlogin from pg_roles where rolname = 'standfast_app'",
    );
    expect(r.rows[0]?.rolbypassrls).toBe(false);
    // A group role. Deployments grant it to a login user; it is not one.
    expect(r.rows[0]?.rolcanlogin).toBe(false);
  });
});

/**
 * The relation kinds that must appear in `WIRE_ALLOWLIST` or
 * `NON_TENANT_TABLES`.
 *
 * `r` is an ordinary table and holds rows. `p` is a partitioned table: it holds
 * no rows itself, but it declares the column set its partitions serve and it is
 * the name a query uses, so a review that skipped it would review nothing that
 * anybody reads. Each partition is an `r` in its own right and is classified in
 * its own right — partitioning a table therefore multiplies the review rather
 * than escaping it.
 */
const CLASSIFIED = new Set(["r", "p"]);

/**
 * Why a relation of this kind may not live in `public` at all, in a sentence
 * that completes `<name> …`.
 *
 * A kind absent from this map and from `CLASSIFIED` is refused too, with the
 * kind quoted back. The failure this file was hardened against was a relation
 * kind the query did not think to ask about, so silence is not a pass.
 */
const REFUSED: Readonly<Record<string, string>> = {
  v: "is a view, and can select columns this guard reviews table by table",
  m: "is a materialized view, and holds its own copy of columns this guard reviews table by table",
  f: "is a foreign table, and reads rows from another server, and sends rows to one when written to",
};

/**
 * Every relation in `public` that can hold or serve a row.
 *
 * `pg_class`, not `information_schema`. The information schema is the SQL
 * standard's view of the catalogue, and a materialized view is not in the
 * standard: it appears in neither `information_schema.tables` nor
 * `information_schema.columns`. A materialized view selecting `documents.body`
 * was therefore invisible to a guard built on that view of the catalogue, while
 * physically holding every body it selected. `pg_class` is the catalogue itself
 * and has a row for every relation the database has.
 *
 * The kinds filtered out here cannot carry a row of anyone's data. An index
 * copies indexed values, but cannot be selected from and can only index columns
 * of a relation that is itself classified, so the base table's review governs
 * it; `I` is the same for a partitioned index. A sequence is a counter of fixed
 * shape with no room for a row. A composite type is a shape and has no storage.
 * TOAST tables are absent from the list on purpose: they hold the overflow of a
 * table's own wide columns, but Postgres puts them in `pg_toast` and offers no
 * way to move one, so the schema filter has already excluded them and a `t` in
 * `public` would be an anomaly worth failing on.
 *
 * `public` only, and that is the entire exclusion. pgboss owns its schema,
 * drizzle its migration ledger, and `auth` holds a function and no storage.
 * Nothing is excluded by ownership: `ALTER EXTENSION … ADD TABLE` would let an
 * ordinary table adopt an extension as cover, and `vector` and `pg_trgm` own no
 * relation here that would need the exemption.
 */
const publicRelations = async () =>
  (
    await admin.query<{ relkind: string; relname: string }>(
      `select relkind::text as relkind, relname from pg_class
        where relnamespace = 'public'::regnamespace
          and relkind not in ('i', 'I', 'S', 'c')
        order by relname`,
    )
  ).rows;

describe("invariant 3 — nothing that could hold source code", () => {
  // Allowlist, never denylist (docs/02-principles.md, 9). A denylist would
  // have to anticipate the name of the column nobody thought to forbid.
  it.each(Object.keys(WIRE_ALLOWLIST))(
    "%s exposes exactly the allowed columns",
    async (table) => {
      const r = await admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table],
      );
      const actual = r.rows.map((row) => row.column_name).sort();
      const allowed = [...(WIRE_ALLOWLIST[table] ?? [])].sort();
      expect(actual).toEqual(allowed);
    },
  );

  // The check above is strong against a new column on a table someone already
  // classified, and blind to a new table. It iterates the allowlist's own keys,
  // so a table a migration created and nobody registered is checked by nothing
  // at all, and the sentence two comments up quietly stops being true for it.
  // The two checks below read the schema instead of the map, and require the
  // two to agree.
  it("classifies every table in the schema", async () => {
    const live = (await publicRelations())
      .filter((row) => CLASSIFIED.has(row.relkind))
      .map((row) => row.relname);
    const classified = new Set([
      ...Object.keys(WIRE_ALLOWLIST),
      ...Object.keys(NON_TENANT_TABLES),
    ]);

    // The instruction travels with the failure. A guard whose diff reads
    // `- "zz_probe"` gets suppressed; one that says what to do gets fixed.
    const unclassified = live
      .filter((table) => !classified.has(table))
      .sort()
      .map(
        (table) =>
          `${table} is not classified. Add it to WIRE_ALLOWLIST with the columns it may serve, or to NON_TENANT_TABLES with the reason it never crosses the wire.`,
      );
    expect(unclassified).toEqual([]);

    // The other direction, for one map only. A stale allowlist key already
    // fails the check above against an empty column set; a stale
    // NON_TENANT_TABLES key fails nothing, and would stand ready to wave
    // through a future table that reuses the name.
    const stale = Object.keys(NON_TENANT_TABLES)
      .filter((table) => !live.includes(table))
      .sort()
      .map(
        (table) =>
          `${table} is in NON_TENANT_TABLES and no longer exists. Remove it, so it cannot vouch for a later table of the same name.`,
      );
    expect(stale).toEqual([]);
  });

  // Exactly one, not at least one: a table in both maps is reviewed by neither,
  // because each side would be entitled to assume the other had done it.
  it("classifies no table twice", async () => {
    const both = Object.keys(NON_TENANT_TABLES)
      .filter((table) => table in WIRE_ALLOWLIST)
      .map(
        (table) =>
          `${table} is in both WIRE_ALLOWLIST and NON_TENANT_TABLES. It belongs in one.`,
      );
    expect(both).toEqual([]);
  });

  // Serving surfaces are in scope, and the decision is that there are none. A
  // view can select any column of any table beneath it, including one nobody
  // allowlisted, and the catalogue reports those columns as the view's own
  // rather than as the table's. A materialized view does that and keeps the
  // copy. A foreign table reads rows from another server, and a write to one
  // sends rows off this machine. Rather than teach this file to resolve a
  // view's dependencies, `public` holds tables, and the first relation of any
  // of these kinds to want a home here has to come through this test and be
  // argued for.
  it("holds nothing in public that serves rows this guard cannot review", async () => {
    const refused = (await publicRelations())
      .filter((row) => !CLASSIFIED.has(row.relkind))
      .map(
        (row) =>
          `${row.relname} ${
            REFUSED[row.relkind] ??
            `is a relation of kind '${row.relkind}', which this guard has no ruling on`
          }. Decide what it may expose and record the decision here.`,
      );
    expect(refused).toEqual([]);
  });
});

describe("the authentication lookup is hardened as migration 0014 says", () => {
  // The comment in src/auth.ts calls the lookup an equality comparison
  // against a unique index. Migration 0014 is what made that sentence true;
  // this pins it. UNIQUE matters as much as the index: resolve_api_key ends
  // in LIMIT 1, and LIMIT 1 must never be what picks between two rows
  // carrying the same hash.
  it("api_keys.hash has a unique index", async () => {
    const r = await admin.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'api_keys'
          and indexname = 'api_keys_hash_key'`,
    );
    expect(r.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(hash\)/);
  });

  // A SECURITY DEFINER pin that omits pg_temp still searches the temporary
  // schema first for relation names. The pin must name it, and name it last.
  it("auth.resolve_api_key pins a search_path ending in pg_temp", async () => {
    const r = await admin.query<{ proconfig: string[] | null }>(
      `select proconfig from pg_proc
        where proname = 'resolve_api_key'
          and pronamespace = 'auth'::regnamespace`,
    );
    const searchPath = (r.rows[0]?.proconfig ?? []).find((entry) =>
      entry.startsWith("search_path="),
    );
    expect(searchPath).toMatch(/^search_path=pg_catalog\b/);
    expect(searchPath).toMatch(/\bpg_temp$/);
  });
});

describe("pgvector is available on this host", () => {
  // Created by 0000 with no vector column yet. If this fails, the retrieval
  // design does not run where the database lives, and that is worth knowing
  // now rather than in phase 1.
  it("has the vector and pg_trgm extensions", async () => {
    const r = await admin.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('vector', 'pg_trgm')",
    );
    expect(r.rows.map((x) => x.extname).sort()).toEqual(["pg_trgm", "vector"]);
  });
});

/**
 * The Drizzle model and the hand-written DDL, compared against the same live
 * database.
 *
 * `WIRE_ALLOWLIST` above is compared to `information_schema`, and that catches a
 * column added to a migration and forgotten in the allowlist. It does not catch
 * the other omission: a column added to a migration *and* to the allowlist but
 * forgotten in `packages/db/src/schema/knowledge.ts`. Nothing would fail —
 * queries never select what the model does not declare — and the model would
 * drift from the table silently, for as long as nobody wrote to the column.
 *
 * That gap is load-bearing here because migrations 0007, 0008 and 0009 are
 * hand-written: drizzle-kit's snapshot chain stops at 0006, so `db:generate`
 * diffs against a stale picture and cannot be the thing that keeps these two in
 * step. This is.
 */
describe("the Drizzle model matches the tables it claims to describe", () => {
  it.each(Object.keys(SCHEMA_TABLES))(
    "%s declares exactly the columns the database has",
    async (table) => {
      const declared = Object.values(
        getTableColumns(SCHEMA_TABLES[table as keyof typeof SCHEMA_TABLES]),
      )
        .map((column) => column.name)
        .sort();

      const actual = await admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by column_name`,
        [table],
      );

      // Equality, not containment — the same argument the wire allowlist makes.
      // A column the database has and the model does not is the drift this
      // exists to catch, and a column the model has and the database does not
      // is a migration nobody applied.
      expect(declared).toEqual(actual.rows.map((r) => r.column_name));
    },
  );
});
