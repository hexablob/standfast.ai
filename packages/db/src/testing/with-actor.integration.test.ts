import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import { adminUrl, ensureTestRole, type Seed, seed } from "./harness.js";

/**
 * `withActor` is the only sanctioned way to reach the database, so it is the
 * only thing standing between application code and a connection with no
 * tenant set. It gets tested as the boundary it is.
 *
 * It is pointed at the unprivileged role here: as the superuser it would pass
 * while proving nothing, because superusers bypass RLS outright.
 */

let data: Seed;
const originalUrl = process.env["DATABASE_URL"];

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) {
    process.env["DATABASE_URL"] = originalUrl;
  }
});

describe("withActor", () => {
  it("sets both tenant settings inside the transaction", async () => {
    const seen = await withActor(data.orgA, data.humanA, async (db) => {
      const r = await db.execute<{ org: string; actor: string }>(
        sql`select current_setting('standfast.org_id') as org,
                   current_setting('standfast.actor_id') as actor`,
      );
      return r.rows[0];
    });

    expect(seen?.org).toBe(data.orgA);
    expect(seen?.actor).toBe(data.humanA);
  });

  it("scopes the caller to its own org", async () => {
    const rows = await withActor(data.orgA, data.humanA, async (db) => {
      const r = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from documents`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(rows).toBeGreaterThan(0);

    const cross = await withActor(data.orgA, data.humanA, async (db) => {
      const r = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from documents where org_id = ${data.orgB}`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(cross).toBe(0);
  });

  // The settings are transaction-local, so the next caller on the same pooled
  // connection must not inherit them. A leak here would be a cross-tenant read
  // that only happens under load, which is the worst kind.
  it("does not leak the tenant to the next call on the same connection", async () => {
    await withActor(data.orgA, data.humanA, async () => undefined);

    const leaked = await withActor(data.orgB, data.humanA, async (db) => {
      const r = await db.execute<{ org: string | null }>(
        sql`select current_setting('standfast.org_id', true) as org`,
      );
      return r.rows[0]?.org;
    });

    expect(leaked).toBe(data.orgB);
  });

  it("rolls back when the callback throws", async () => {
    await expect(
      withActor(data.orgA, data.humanA, async (db) => {
        await db.execute(
          sql`insert into projects (org_id, name, slug) values (${data.orgA}, 'rollback', 'rollback-me')`,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const left = await withActor(data.orgA, data.humanA, async (db) => {
      const r = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from projects where slug = 'rollback-me'`,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
    expect(left).toBe(0);
  });
});
