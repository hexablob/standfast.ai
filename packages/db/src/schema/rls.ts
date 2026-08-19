import { sql } from "drizzle-orm";
import { pgPolicy, pgRole } from "drizzle-orm/pg-core";

/**
 * The role the API connects through. NOLOGIN group role, created by migration
 * 0000; a deployment grants it to whatever login user it uses. It must never
 * hold BYPASSRLS, and there is a test that checks.
 */
export const standfastApp = pgRole("standfast_app");

/**
 * Transaction-scoped tenant, read from a GUC set by `withActor`.
 *
 * Two layers, and both are needed:
 *
 * - `current_setting(name, true)` returns NULL instead of raising when the
 *   setting was never defined in this session.
 * - `nullif(..., '')` handles the case that actually bites. Once a GUC has
 *   been set on a connection — even transaction-locally — the placeholder
 *   survives the transaction with an *empty string* value rather than
 *   disappearing. Without the `nullif`, the next query on that pooled
 *   connection evaluates `''::uuid` and raises `invalid input syntax for
 *   type uuid` instead of returning nothing.
 *
 * `org_id = NULL` is never true, so a connection that forgot to set the GUC
 * sees zero rows rather than every row. Failing closed is the whole design,
 * and `rls.integration.test.ts` asserts it on a connection that has already
 * served another transaction — which is the only way this shows up.
 */
export const currentOrgId = sql`nullif(current_setting('standfast.org_id', true), '')::uuid`;

export const currentActorId = sql`nullif(current_setting('standfast.actor_id', true), '')::uuid`;

/**
 * Same predicate on read and on write. Without `withCheck`, a tenant could
 * not read another org's rows but could still insert rows carrying another
 * org's id — visible to nobody, and a corruption of the tenant boundary.
 */
export function orgIsolationPolicy(table: string) {
  return pgPolicy(`${table}_org_isolation`, {
    as: "permissive",
    for: "all",
    to: standfastApp,
    using: sql`org_id = ${currentOrgId}`,
    withCheck: sql`org_id = ${currentOrgId}`,
  });
}

/**
 * `orgs` is the tenant root and has no `org_id` column — its own primary key
 * is what the GUC names.
 */
export function orgRootPolicy() {
  return pgPolicy("orgs_org_isolation", {
    as: "permissive",
    for: "all",
    to: standfastApp,
    using: sql`id = ${currentOrgId}`,
    withCheck: sql`id = ${currentOrgId}`,
  });
}
