import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;

/**
 * Internal. Deliberately absent from `index.ts`, and the package `exports`
 * map publishes only `.`, so Node refuses a deep import of this module. The
 * pool is reachable from inside the package and nowhere else.
 *
 * The only legitimate caller outside `withActor` is `resolveApiKey`, which
 * runs before a tenant is known.
 */
export function getPool(): Pool {
  if (!pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error("DATABASE_URL is not set.");
    }
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/**
 * The only sanctioned way to reach the database.
 *
 * Opens a transaction, sets `standfast.org_id` and `standfast.actor_id` as
 * transaction-local settings, and runs the callback. Row-level security reads
 * those settings; a query issued outside this wrapper sees zero rows, because
 * `org_id = NULL` is never true.
 *
 * There is deliberately no exported pool or bare `db` handle. Exporting one
 * would be exporting a way to bypass tenant isolation by forgetting a call —
 * and a boundary you can cross by forgetting something is not a boundary.
 */
export async function withActor<T>(
  orgId: string,
  actorId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const db = drizzle(getPool(), { schema });

  return db.transaction(async (tx) => {
    // set_config(..., true) scopes the setting to this transaction, so a
    // pooled connection cannot leak one request's tenant into the next.
    await tx.execute(
      sql`select set_config('standfast.org_id', ${orgId}, true)`,
    );
    await tx.execute(
      sql`select set_config('standfast.actor_id', ${actorId}, true)`,
    );
    return fn(tx as unknown as Db);
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
