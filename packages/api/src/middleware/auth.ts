import { type Db, resolveApiKey, withActor } from "@standfast/db";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type AuthVariables = {
  orgId: string;
  actorId: string;
  scopes: string[];
};

/**
 * Resolves `Authorization: Bearer sf_sk_…` to a tenant.
 *
 * This is the only request path that touches the database outside
 * `withActor`, because the tenant is what it is computing. Revocation and
 * expiry are enforced by the policy behind `auth.resolve_api_key`, not here.
 *
 * `last_used_at` is deliberately not written. A write on every authenticated
 * request is a real cost with no consumer in phase 0, and it would turn every
 * read into a read-write transaction.
 */
export const requireApiKey: MiddlewareHandler<{
  Variables: AuthVariables;
}> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    throw new HTTPException(401, { message: "Missing API key." });
  }

  const resolved = await resolveApiKey(token);
  if (!resolved) {
    // One message for absent, revoked, expired and wrong. Distinguishing them
    // tells an attacker which of their guesses was once a real key.
    throw new HTTPException(401, { message: "Invalid API key." });
  }

  c.set("orgId", resolved.orgId);
  c.set("actorId", resolved.actorId);
  c.set("scopes", resolved.scopes);

  await next();
};

/** Runs `fn` under the authenticated tenant. */
export function asTenant<T>(
  c: Context<{ Variables: AuthVariables }>,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withActor(c.get("orgId"), c.get("actorId"), fn);
}
