import { DOCUMENT_BODY_MAX_CHARS } from "@standfast/core";
import { closePool, generateApiKey } from "@standfast/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

/**
 * The two bounds on the unauthenticated edge of the API.
 *
 * `docs/13-threat-model.md` listed both as open and cheap: nothing throttled a
 * failed authentication attempt, and `PutDocument.body` was an unbounded
 * string. Neither is a denial-of-service defence — availability is out of
 * scope in that document and stays out of it. One is a guessing throttle on
 * the credential surface, the other is input validation at a trust boundary.
 *
 * This suite lives in its own file rather than beside the other API tests
 * because the throttle's counters are module state. `vitest.config.ts` runs
 * files sequentially and isolates their module graphs, so a burst here cannot
 * make some unrelated assertion elsewhere collect a 429 where it expected a
 * 401.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();

let apiKey = "";
let projectId = "";

beforeAll(async () => {
  const db = new Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE standfast_test LOGIN PASSWORD 'standfast_test' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query('GRANT "standfast_app" TO standfast_test');

    const suffix = `${Date.now()}-${process.pid}`;
    const org = await db.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $1) returning id",
      [`limits-${suffix}`],
    );
    const orgId = org.rows[0]?.id;

    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', $2) returning id",
      [orgId, "human"],
    );

    // putDocument resolves the extractor actor to attribute its jobs, and
    // refuses to mint one itself. Production creates it with the org.
    await db.query(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor')",
      [orgId],
    );

    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [
        orgId,
        actor.rows[0]?.id,
        `${generated.prefix}-${suffix}`,
        generated.hash,
      ],
    );
    apiKey = generated.key;
  } finally {
    await db.end();
  }

  const url = new URL(adminUrl);
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();

  const created = await call("/v1/projects", apiKey, {
    method: "POST",
    body: JSON.stringify({ name: "Limits", slug: `limits-${Date.now()}` }),
  });
  projectId = ((await created.json()) as { id: string }).id;
});

afterAll(async () => {
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
});

const call = (path: string, key: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });

const putDocument = (body: string) =>
  call(`/v1/projects/${projectId}/documents`, apiKey, {
    method: "PUT",
    body: JSON.stringify({ path: "docs/big.md", title: null, body }),
  });

/**
 * Ordered on purpose. The burst has to happen before the window expiry, and
 * the valid-key assertion has to happen after the burst — that one is the
 * point of the whole design, not a bonus.
 */
describe("failed authentication is throttled", () => {
  it("refuses a burst of failures with 429 once it crosses the threshold", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 30; i += 1) {
      seen.add((await call("/v1/projects", "sf_sk_nope")).status);
    }
    expect(seen).toEqual(new Set([401, 429]));
  });

  it("never throttles a valid key, even after the burst", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await call("/v1/projects", apiKey)).status).toBe(200);
    }
  });

  it("leaks nothing in the 429 body", async () => {
    const response = await call("/v1/projects", "sf_sk_nope");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many requests." });
  });

  it("still refuses an absent key indistinguishably from a wrong one", async () => {
    const absent = await call("/v1/projects", null);
    const wrong = await call("/v1/projects", "sf_sk_alsonope");
    expect(absent.status).toBe(429);
    expect(await absent.json()).toEqual(await wrong.json());
  });

  it("forgives the address once the window has passed", async () => {
    const now = Date.now();
    // The window is a minute; a test that waited one would be a test nobody
    // runs. Only the limiter's clock is moved.
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    try {
      expect((await call("/v1/projects", "sf_sk_nope")).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("document body size", () => {
  it("accepts a body at exactly the cap", async () => {
    const response = await putDocument("x".repeat(DOCUMENT_BODY_MAX_CHARS));
    expect(response.status).toBe(200);
  });

  it("refuses one character over the cap, naming the limit", async () => {
    const response = await putDocument("x".repeat(DOCUMENT_BODY_MAX_CHARS + 1));
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(String(DOCUMENT_BODY_MAX_CHARS));
  });

  it("refuses an oversized payload before it is parsed", async () => {
    // Not JSON, and far too large. A 400 here would mean something tried to
    // parse it; the 413 means the byte limit ran first.
    const response = await call(`/v1/projects/${projectId}/documents`, apiKey, {
      method: "PUT",
      body: "{".repeat(5 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body too large." });
  });
});

/**
 * The ceiling on the one field that carries whatever a developer typed.
 *
 * `docs/13-threat-model.md` §5, *The `UserPromptSubmit` hook*: that hook uses
 * the raw prompt as the retrieval query, so this cap is what stands between a
 * pasted function and the query embedder. What matters is not the number — 4,000
 * is an interface bound, and the document says so — but the *shape* of the
 * refusal. A cap that truncated and forwarded would send the first 4,000
 * characters of the paste; this one sends nothing. That is the property worth
 * pinning, because nothing else in the codebase states it.
 *
 * Written against the wire rather than against the Zod object, so a change that
 * kept the schema and moved the coercion elsewhere would still be caught. The
 * literal lives in `packages/api/src/schemas.ts` and is not exported.
 */
const QUERY_MAX_CHARS = 4000;

const postContext = (query: string) =>
  call(`/v1/projects/${projectId}/context`, apiKey, {
    method: "POST",
    body: JSON.stringify({ scope: "task", query, budgetTokens: 400 }),
  });

describe("retrieval query size", () => {
  it("accepts a query at exactly the cap", async () => {
    const response = await postContext("x".repeat(QUERY_MAX_CHARS));
    expect(response.status).toBe(200);
  });

  it("refuses one character over the cap rather than truncating it", async () => {
    const response = await postContext("x".repeat(QUERY_MAX_CHARS + 1));
    expect(response.status).toBe(400);
  });

  it("fails closed: the oversized query reaches no retrieval stage", async () => {
    // The positive control is above — 4,000 characters returns a pack. A 400
    // carries no envelope at all, so there is no `skipped`, no `total`, and
    // nothing that could have been produced by embedding the prompt.
    const response = await postContext("x".repeat(QUERY_MAX_CHARS + 1));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["items"]).toBeUndefined();
    expect(body["skipped"]).toBeUndefined();
  });
});
