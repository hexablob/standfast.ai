import { getConnInfo } from "@hono/node-server/conninfo";
import { type Db, resolveApiKey, withActor } from "@standfast/db";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type AuthVariables = {
  orgId: string;
  actorId: string;
  scopes: string[];
};

/**
 * A throttle on *failed* authentication, and on nothing else.
 *
 * It does not help against a 256-bit key — nothing guesses one of those — and
 * it is **not** a denial-of-service defence; `docs/13-threat-model.md` puts
 * availability out of scope and this does not quietly put it back in. What it
 * covers is the rest of the same surface: a revoked key retried in a loop, a
 * key lifted from a shell history and probed against several deployments, a
 * script walking a list of prefixes. Those are cheap to attempt and, until
 * now, free to attempt indefinitely.
 *
 * A request carrying a **valid** key is never counted and never refused, at
 * any rate, from any address. The read path's latency budget is a product
 * promise (`docs/06-retrieval.md`), and a limiter that could slow a legitimate
 * `context` call would trade a property this project actually sells for a
 * speculative one. That is also why the counter is consulted only after the
 * key has already been resolved and found wanting.
 *
 * ponytail: the counters are per process and in memory. A deployment running
 * N API processes behind a load balancer therefore permits N ×
 * `AUTH_MAX_FAILURES` failures per window, because each process counts alone,
 * and a restart forgives everything outstanding. The upgrade path is a shared
 * counter — the Postgres this process already holds a pool to, or a Redis —
 * keyed exactly as below. It is not built: one process is what is deployed
 * today, and a shared store would put a second network round trip and a new
 * failure mode on the authentication path in exchange for a bound nobody has
 * yet had a reason to want.
 */
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 20;

/**
 * The ceiling on distinct addresses tracked at once.
 *
 * A limiter that grows a map per source address is a memory exhaustion
 * primitive wearing the costume of a defence: spraying one failed request from
 * each of a million addresses would otherwise cost the attacker nothing and
 * this process a million entries.
 */
const AUTH_MAX_TRACKED = 10_000;

const failures = new Map<string, { count: number; resetAt: number }>();

/**
 * The client's address as the socket reports it.
 *
 * Deliberately not `X-Forwarded-For`: that header is written by whoever is
 * calling unless a trusted proxy overwrites it, so keying on it would let any
 * caller pick their own bucket — and a fresh one per request.
 *
 * Everything whose address cannot be determined shares a single bucket. That
 * is the in-process test app, which has no socket at all; if it were ever a
 * real deployment the consequence is bounded, because the only thing that
 * lands in a bucket is a request that already failed to authenticate.
 */
function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Drops expired entries, then the oldest, until there is room for one more. */
function makeRoom(now: number): void {
  if (failures.size < AUTH_MAX_TRACKED) {
    return;
  }
  for (const [address, seen] of failures) {
    if (seen.resetAt <= now) {
      failures.delete(address);
    }
  }
  while (failures.size >= AUTH_MAX_TRACKED) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    failures.delete(oldest);
  }
}

/** Records one failed attempt; true once this address is over the line. */
function overFailureLimit(c: Context): boolean {
  const address = clientAddress(c);
  const now = Date.now();
  const seen = failures.get(address);

  // Fixed window rather than sliding: one timestamp and one integer per
  // address, and the burst it lets through at a window boundary is bounded by
  // twice a number that already only governs guesses.
  if (!seen || seen.resetAt <= now) {
    makeRoom(now);
    failures.set(address, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return false;
  }

  seen.count += 1;
  return seen.count > AUTH_MAX_FAILURES;
}

/**
 * The single refusal, counted.
 *
 * The 429 carries no detail for the same reason the 401 carries one message
 * for four causes: absent, revoked, expired and wrong must stay
 * indistinguishable, and a throttle that answered differently once a guess got
 * close would be the oracle the 401 exists to deny.
 */
function refuse(c: Context, message: string): HTTPException {
  return overFailureLimit(c)
    ? new HTTPException(429, { message: "Too many requests." })
    : new HTTPException(401, { message });
}

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
  // RFC 7235 §2.1 makes the scheme case-insensitive, and a client library or a
  // proxy is free to send `bearer`. Matching only `Bearer ` would refuse a
  // correct credential, and the refusal would be counted against the caller's
  // address like any other — so a client whose only fault is lower case would
  // eventually be throttled for holding a valid key.
  const token =
    header && /^bearer /i.test(header) ? header.slice(7).trim() : "";

  if (!token) {
    throw refuse(c, "Missing API key.");
  }

  const resolved = await resolveApiKey(token);
  if (!resolved) {
    // One message for absent, revoked, expired and wrong. Distinguishing them
    // tells an attacker which of their guesses was once a real key.
    throw refuse(c, "Invalid API key.");
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
