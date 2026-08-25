import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closePool, generateApiKey } from "@standfast/db";
import { createServer } from "@standfast/mcp";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * Drives the MCP server over a real protocol round-trip, against the real API.
 *
 * The client and server are joined by an in-memory transport, so this
 * exercises tool listing, argument validation and result shaping exactly as a
 * coding agent would — not the handler functions in isolation.
 *
 * Here rather than in packages/mcp because of the licence direction: this
 * package is AGPL-3.0 and may depend on the Apache-2.0 MCP server. The reverse
 * would contaminate a package that ships to users' machines.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();

let client: Client;
let projectId = "";
let documentId = "";
let sectionId = "";

beforeAll(async () => {
  const db = new PgClient({ connectionString: adminUrl });
  await db.connect();
  let apiKey = "";
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE standfast_test LOGIN PASSWORD 'standfast_test' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query('GRANT "standfast_app" TO standfast_test');

    const suffix = `${Date.now()}-${process.pid}`;
    const org = await db.query<{ id: string }>(
      "insert into orgs (name, slug) values ($1, $1) returning id",
      [`mcp-${suffix}`],
    );
    const actor = await db.query<{ id: string }>(
      "insert into actors (org_id, kind, display_name) values ($1, 'agent', 'agent') returning id",
      [org.rows[0]?.id],
    );

    // Production creates this with the org (bootstrap.ts, migration 0004), so a
    // test that creates an org creates one too. putDocument resolves it to
    // attribute extraction jobs, and deliberately refuses to mint one itself.
    await db.query(
      "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor')",
      [org.rows[0]?.id],
    );
    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [
        org.rows[0]?.id,
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

  // Seed a project, a document and its derived section through the API.
  const authed = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

  const project = await (
    await authed("/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: "MCP", slug: `mcp-${Date.now()}` }),
    })
  ).json();
  projectId = (project as { id: string }).id;

  const doc = await (
    await authed(`/v1/projects/${projectId}/documents`, {
      method: "PUT",
      body: JSON.stringify({
        path: "docs/rules.md",
        body: "# Rule\nAlways ship on Fridays.",
      }),
    })
  ).json();
  documentId = (doc as { id: string }).id;

  const sections = (await (
    await authed(`/v1/documents/${documentId}/sections`)
  ).json()) as { items: { id: string }[] };
  sectionId = sections.items[0]?.id ?? "";

  const server = createServer({
    baseUrl: "http://standfast.test",
    apiKey,
    fetch: ((input: Request) => app.request(input)) as typeof globalThis.fetch,
  });

  client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterAll(async () => {
  await client?.close();
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
});

const text = (result: unknown): string => {
  const content = (result as { content: { type: string; text: string }[] })
    .content;
  return content.map((c) => c.text).join("");
};

describe("the MCP catalogue", () => {
  it("advertises the six tools that exist", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "context",
      "propose",
      "read",
      "reconcile",
      "search",
      "status",
    ]);
  });

  /**
   * The third founding invariant, asserted at the surface an agent actually
   * touches.
   *
   * `reconcile` is the one tool called by an agent that has just finished
   * reading source, so it is the one place a snippet could plausibly be
   * offered. The request schema is `.strict()`, which makes an unlisted field a
   * refusal rather than a field quietly dropped — and quietly dropped is the
   * dangerous outcome, because it looks like acceptance to whoever sent it.
   *
   * This test replaced one asserting `reconcile` was absent. The guard has to
   * move with the tool, not retire with it.
   *
   * The assertion is on the *message*, not merely on `isError`. An earlier
   * version of this test passed for a reason that had nothing to do with the
   * extra field — the atom id it used did not exist, so the call failed on a
   * foreign key — and it would have gone on passing after the guard was
   * removed. A test that cannot fail for the right reason is not a guard.
   */
  it("refuses a reconcile field that could carry code", async () => {
    const result = await client.callTool({
      name: "reconcile",
      arguments: {
        projectId,
        items: [
          {
            atomId: "00000000-0000-0000-0000-000000000000",
            verdict: "honored",
            filePath: "src/a.ts",
            snippet: "export function f() { return 1; }",
          },
        ],
      },
    });

    expect(result.isError).toBe(true);
    const message = JSON.stringify(result.content);
    // Refused because the field is not on the list, and said so — never
    // stripped and reported as success, which is what an agent would read as
    // permission to keep sending it.
    expect(message).toMatch(/unrecognized|not allowed|snippet/i);
  });

  /**
   * Ten is the cap and four slots are deliberately unspent
   * (`docs/02-principles.md`, 3). Asserted on the live catalogue as well as on
   * the descriptions, because a tool can be registered without its description
   * ever passing through `budget.test.ts`.
   */
  it("leaves the unspent slots unspent", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeLessThanOrEqual(6);
  });

  it("offers no ratify tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("ratify");
  });
});

describe("read", () => {
  it("returns a document", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: { kind: "document", id: documentId },
    });
    expect(text(result)).toContain("Always ship on Fridays.");
  });

  it("returns a section on its own", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: { kind: "section", id: sectionId },
    });
    expect(text(result)).toContain("Rule");
  });

  it("reports a missing entity as an error rather than empty success", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: {
        kind: "atom",
        id: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  // The SDK surfaces validation failures as an error *result* rather than a
  // thrown exception, which is the right shape: the agent reads the reason
  // and can correct itself instead of the call vanishing.
  it("rejects a malformed id at the protocol boundary", async () => {
    const result = await client.callTool({
      name: "read",
      arguments: { kind: "atom", id: "nope" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toMatch(/uuid/i);
  });
});

describe("propose", () => {
  it("stores a provisional atom and says so", async () => {
    const result = await client.callTool({
      name: "propose",
      arguments: {
        projectId,
        documentId,
        sectionId,
        statement: "Ship on Fridays.",
        kind: "convention",
        // Offsets are into the section body, which carries its heading line,
        // so the quote starts after "# Rule\n".
        sourceQuote: "Always ship on Fridays.",
        sourceSpan: { start: 7, end: 30 },
      },
    });

    const body = text(result);
    expect(body).toContain('"status": "provisional"');
    // Said back explicitly, so an agent does not report the matter settled
    // and skip surfacing it to the human.
    expect(body).toContain("A human must ratify it");
  });

  // The API has no status field on create, so this is unrepresentable rather
  // than merely refused — the protocol layer rejects the unknown argument.
  it("gives an agent no way to ask for canonical", async () => {
    const { tools } = await client.listTools();
    const propose = tools.find((t) => t.name === "propose");
    expect(
      Object.keys(
        (propose?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      ),
    ).not.toContain("status");
  });

  it("refuses an atom with no provenance quote", async () => {
    const result = await client.callTool({
      name: "propose",
      arguments: {
        projectId,
        documentId,
        sectionId,
        statement: "No source.",
        kind: "decision",
        sourceQuote: "",
        sourceSpan: { start: 0, end: 1 },
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("status", () => {
  it("counts what is waiting on a human", async () => {
    const result = await client.callTool({
      name: "status",
      arguments: { projectId },
    });
    const body = JSON.parse(text(result)) as {
      counts: {
        provisional: number;
        canonical: number;
        rejected: number;
        superseded: number;
      };
      awaitingRatification: number;
    };

    expect(body.counts.provisional).toBeGreaterThan(0);
    expect(body.awaitingRatification).toBe(body.counts.provisional);

    /**
     * No `truncated`, and its absence is the point.
     *
     * These counts come from an aggregate over every atom in the project, so
     * there is no page and nothing to have been dropped. The tool used to scan
     * atoms and cap the scan locally, which meant that past the cap it reported
     * counts of an arbitrary prefix — a project with more atoms than the cap
     * under-reported the ratification queue, and reported it as truncated
     * rather than as wrong.
     */
    expect(Object.keys(body)).not.toContain("truncated");
    expect(Object.keys(body)).not.toContain("scanned");
  });
});
