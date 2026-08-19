import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_TABLES, WIRE_ALLOWLIST } from "../schema/wire-allowlist.js";
import { adminClient } from "./harness.js";

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
