import { closePool, generateApiKey } from "@standfast/db";
import { createClient } from "@standfast/sdk";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * Proves the generated client and the running server agree.
 *
 * `@standfast/sdk` is generated from the committed `infra/openapi/openapi.json`,
 * never from a live server, so nothing guarantees the two match except a test
 * that drives one through the other. A generated client that typechecks
 * against a stale spec is exactly the failure the committed artifact exists to
 * prevent, and it is invisible without this.
 *
 * The test lives here rather than in `packages/sdk` because of the licence
 * direction: this package is AGPL-3.0 and may depend on the Apache-2.0 SDK.
 * The reverse would contaminate a package that ships to users' machines.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();

let apiKey = "";

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
      [`sdk-${suffix}`],
    );
    const orgId = org.rows[0]?.id;

    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'human', $2) returning id",
      [orgId, "human"],
    );

    // Production creates this with the org (bootstrap.ts, migration 0004), so a
    // test that creates an org creates one too. putDocument resolves it to
    // attribute extraction jobs, and deliberately refuses to mint one itself.
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
});

afterAll(async () => {
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
});

/** Routes the SDK's fetch into the Hono app, no socket involved. */
const client = () =>
  createClient({
    baseUrl: "http://standfast.test",
    apiKey,
    fetch: ((input: Request) => app.request(input)) as typeof globalThis.fetch,
  });

describe("@standfast/sdk against the running API", () => {
  it("creates and reads a project through the generated types", async () => {
    const sdk = client();

    const created = await sdk.POST("/v1/projects", {
      body: { name: "SDK", slug: `sdk-${Date.now()}` },
    });
    expect(created.response.status).toBe(201);
    expect(created.data?.id).toBeDefined();

    const listed = await sdk.GET("/v1/projects");
    expect(listed.response.status).toBe(200);
    expect(listed.data?.items.some((p) => p.id === created.data?.id)).toBe(
      true,
    );
  });

  it("round-trips a document and its derived sections", async () => {
    const sdk = client();

    const project = await sdk.POST("/v1/projects", {
      body: { name: "Docs", slug: `docs-${Date.now()}` },
    });
    const projectId = project.data?.id ?? "";

    const put = await sdk.PUT("/v1/projects/{projectId}/documents", {
      params: { path: { projectId } },
      body: { path: "docs/a.md", body: "# One\nalpha\n\n# Two\nbeta" },
    });
    expect(put.response.status).toBe(200);

    const sections = await sdk.GET("/v1/documents/{documentId}/sections", {
      params: { path: { documentId: put.data?.id ?? "" } },
    });
    expect(sections.data?.items.map((s) => s.headingPath)).toEqual([
      ["One"],
      ["Two"],
    ]);
  });

  it("surfaces an error status rather than throwing", async () => {
    const sdk = client();
    const slug = `dup-${Date.now()}`;

    await sdk.POST("/v1/projects", { body: { name: "A", slug } });
    const again = await sdk.POST("/v1/projects", { body: { name: "A", slug } });

    expect(again.response.status).toBe(409);
    expect(again.data).toBeUndefined();
    expect(again.error).toBeDefined();
  });

  it("refuses to build a client with no key", () => {
    expect(() => createClient({ baseUrl: "http://x", apiKey: "" })).toThrow(
      /apiKey/,
    );
  });
});
