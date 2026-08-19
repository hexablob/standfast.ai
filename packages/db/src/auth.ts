import { createHash, randomBytes } from "node:crypto";
import { getPool } from "./client.js";

const KEY_PREFIX = "sf_sk_";
/** Enough of the key to identify it in a list, and useless on its own. */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;

export type ResolvedKey = {
  orgId: string;
  actorId: string;
  scopes: string[];
};

/**
 * SHA-256, not a password KDF.
 *
 * A key is 256 bits from a CSPRNG, so there is no dictionary and no guessing
 * attack for argon2 or bcrypt to slow down. What a slow KDF would reliably do
 * is add tens of milliseconds to every authenticated request, and p95 latency
 * is a contract (docs/02-principles.md, 4).
 *
 * Note that lookup is an indexed equality comparison inside Postgres, not a
 * comparison in JavaScript — there is no place here for `timingSafeEqual` to
 * apply. The timing channel that leaves is not useful to an attacker: probing
 * it reveals something about where a hash sits in an index, and turning that
 * into a key would mean constructing a SHA-256 preimage.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): {
  key: string;
  prefix: string;
  hash: string;
} {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    key,
    prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
    hash: hashApiKey(key),
  };
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX);
}

/**
 * The one query that runs before a tenant is known, and therefore the only
 * one not wrapped in `withActor`.
 *
 * It calls `auth.resolve_api_key`, a SECURITY DEFINER function owned by a
 * NOLOGIN role with a single narrow SELECT policy. Revocation and expiry are
 * enforced by that policy, not here — an expired key is invisible to the
 * lookup rather than filtered by application code someone could reorder.
 */
export async function resolveApiKey(key: string): Promise<ResolvedKey | null> {
  const result = await getPool().query<{
    org_id: string;
    actor_id: string;
    scopes: string[];
  }>("select org_id, actor_id, scopes from auth.resolve_api_key($1)", [
    hashApiKey(key),
  ]);

  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return { orgId: row.org_id, actorId: row.actor_id, scopes: row.scopes ?? [] };
}
