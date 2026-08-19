import { generateApiKey } from "@standfast/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * `context` and `search` over HTTP, which is the only place several contracts
 * meet.
 *
 * The pieces are tested apart: the fused query against a real database in
 * `packages/db`, the assembler and its budget as pure functions in
 * `packages/core`, the hooks against a stubbed client in `packages/mcp`. None
 * of those exercises the route — where the tenant is resolved from a key, the
 * envelope is serialised, `skipped` is populated by whichever ports the process
 * was built with, and the budget the caller named is the one the assembler
 * receives.
 *
 * The app here is built with no retrieval ports, which is what every deployment
 * has today and what CI has always. So these tests also pin the shape of the
 * degraded answer, which is the only answer this system currently gives.
 */

let app: ReturnType<typeof createApp>;
let key = "";
let projectId = "";
let otherOrgProjectId = "";
let sectionId = "";

const BODY = "# Rules\nQuoted verbatim.";
const QUOTE = "Quoted verbatim.";
const SPAN = `[${BODY.indexOf(QUOTE)},${BODY.indexOf(QUOTE) + QUOTE.length})`;

beforeAll(async () => {
  const db = new Client({ connectionString: process.env["DATABASE_URL"] });
  await db.connect();

  try {
    const one = async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[],
    ): Promise<T> => (await db.query<T>(sql, params)).rows[0] as T;

    const org = async (slug: string) =>
      (
        await one<{ id: string }>(
          "insert into orgs (name, slug) values ($1, $1) returning id",
          [`${slug}-${Date.now()}-${process.pid}`],
        )
      ).id;

    const orgA = await org("ret-a");
    const orgB = await org("ret-b");

    const human = (
      await one<{ id: string }>(
        "insert into actors (org_id, kind, display_name) values ($1, 'human', 'h') returning id",
        [orgA],
      )
    ).id;

    const generated = generateApiKey();
    await db.query(
      `insert into api_keys (org_id, actor_id, prefix, hash, scopes)
       values ($1, $2, $3, $4, ARRAY['read','write'])`,
      [orgA, human, `${generated.prefix}-${Math.random()}`, generated.hash],
    );
    key = generated.key;

    projectId = (
      await one<{ id: string }>(
        "insert into projects (org_id, name, slug) values ($1, 'A', 'a') returning id",
        [orgA],
      )
    ).id;

    const documentId = (
      await one<{ id: string }>(
        `insert into documents (org_id, project_id, path, body, content_hash)
         values ($1, $2, 'docs/rules.md', $3, 'h') returning id`,
        [orgA, projectId, BODY],
      )
    ).id;

    sectionId = (
      await one<{ id: string }>(
        `insert into document_sections (org_id, document_id, ordinal, heading_path, body, section_hash)
         values ($1, $2, 0, ARRAY['Rules'], $3, 's') returning id`,
        [orgA, documentId, BODY],
      )
    ).id;

    // Canonical atoms, which is the only status retrieval returns. Written
    // through SQL because the API deliberately cannot create one: everything an
    // agent writes is born provisional, and ratification is phase 4's surface.
    const atom = (statement: string, kind: string) =>
      db.query(
        `insert into atoms
           (org_id, project_id, document_id, section_id, statement, kind, status,
            source_quote, source_span, ratified_by, ratified_by_kind, ratified_at)
         values ($1,$2,$3,$4,$5,$6,'canonical',$7,$8::int4range,$9,'human',now())`,
        [
          orgA,
          projectId,
          documentId,
          sectionId,
          statement,
          kind,
          QUOTE,
          SPAN,
          human,
        ],
      );

    await atom("packages/core is pure domain: no I/O.", "constraint");
    await atom("Every migration is reversible.", "convention");
    await atom("Postgres 16 with pgvector was chosen.", "decision");

    // A second org, so a cross-tenant request has something real to fail to
    // see rather than merely finding nothing.
    otherOrgProjectId = (
      await one<{ id: string }>(
        "insert into projects (org_id, name, slug) values ($1, 'B', 'b') returning id",
        [orgB],
      )
    ).id;
  } finally {
    await db.end();
  }

  app = createApp();
});

afterAll(async () => {
  const { closePool } = await import("@standfast/db");
  await closePool();
});

const post = (path: string, body: unknown, token = key) =>
  app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

type Pack = {
  items: {
    atomId: string;
    statement: string;
    kind: string;
    provenance: string;
  }[];
  total: number;
  returned: number;
  truncated: boolean;
  skipped: string[];
  budgetTokensUsed: number;
};

describe("POST /v1/projects/{id}/context", () => {
  it("answers a query-less request from the structural generator alone", async () => {
    // The `SessionStart` shape: a project, no query, no model call anywhere on
    // the path. The highest-frequency call in the system.
    const res = await post(`/v1/projects/${projectId}/context`, {
      scope: "project",
    });

    expect(res.status).toBe(200);
    const pack = (await res.json()) as Pack;

    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.items[0]?.kind).toBe("constraint");
    expect(pack.items[0]?.provenance).toContain("docs/rules.md#");
  });

  /**
   * `docs/06-retrieval.md` condition 5, at the boundary an agent actually
   * reads. No ports are bound, so nothing was embedded and nothing was
   * reranked, and the response says which rather than implying a full search.
   */
  it("names the stages that did not run", async () => {
    const res = await post(`/v1/projects/${projectId}/context`, {
      scope: "task",
      query: "how should the core package be structured",
    });

    const pack = (await res.json()) as Pack;

    // "dense" because a query was given and no embedder exists to embed it;
    // "reranker" because no provider is bound and none may be.
    expect(pack.skipped).toContain("dense");
    expect(pack.skipped).toContain("reranker");
  });

  it("does not report dense as skipped when there was nothing to embed", async () => {
    // A query-less request makes no model call because there is no query, not
    // because a call failed. Reporting it as skipped would make the field
    // non-empty on every session start, and a field that is always the same
    // carries nothing.
    const res = await post(`/v1/projects/${projectId}/context`, {
      scope: "project",
    });

    expect(((await res.json()) as Pack).skipped).not.toContain("dense");
  });

  /**
   * Roadmap phase 2, exit criterion 1, at the layer the caller sees: the pack
   * is at or under the budget it asked for.
   */
  it("respects the budget the caller named", async () => {
    for (const budgetTokens of [80, 200, 2000]) {
      const res = await post(`/v1/projects/${projectId}/context`, {
        scope: "project",
        budgetTokens,
      });

      const pack = (await res.json()) as Pack;
      expect(pack.budgetTokensUsed).toBeLessThanOrEqual(budgetTokens);
    }
  });

  it("says it was truncated when the budget dropped something", async () => {
    const res = await post(`/v1/projects/${projectId}/context`, {
      scope: "project",
      budgetTokens: 90,
    });

    const pack = (await res.json()) as Pack;
    expect(pack.returned).toBeLessThan(pack.total);
    expect(pack.truncated).toBe(true);
  });

  it("returns an empty pack, not an error, for a project with nothing in it", async () => {
    // docs/01-thesis.md: the pack informs the work, it never gates it.
    const res = await post(`/v1/projects/${otherOrgProjectId}/context`, {
      scope: "project",
    });

    // Another org's project is invisible, so this is the same answer a caller
    // gets for an empty project of their own — which is the point: the two
    // must be indistinguishable, or existence becomes an oracle.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const pack = (await res.json()) as Pack;
      expect(pack.items).toEqual([]);
    }
  });

  it("refuses an unauthenticated request", async () => {
    const res = await app.request(`/v1/projects/${projectId}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("POST /v1/projects/{id}/search", () => {
  it("finds an atom by the words it shares with the query", async () => {
    const res = await post(`/v1/projects/${projectId}/search`, {
      query: "migration reversible",
      mode: "lexical",
    });

    expect(res.status).toBe(200);
    const found = (await res.json()) as {
      items: { statement: string; provenance: string }[];
      total: number;
      truncated: boolean;
      skipped: string[];
    };

    expect(found.items.map((i) => i.statement)).toContain(
      "Every migration is reversible.",
    );
    expect(found.items[0]?.provenance).toContain("docs/rules.md#");
  });

  /**
   * The other termination of the same pipeline: a ranked list, no assembly, no
   * budget. `budgetTokensUsed` belongs to `context` and must not appear here.
   */
  it("returns a ranked list rather than a packed one", async () => {
    const res = await post(`/v1/projects/${projectId}/search`, {
      query: "pure domain",
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("budgetTokensUsed");
    expect(Object.keys(body)).toContain("truncated");
  });

  it("returns nothing at all in semantic mode, and says why", async () => {
    // The mode that runs generator 1 alone. With no embedder there is no
    // generator, so there are no candidates — and `skipped` is the only thing
    // separating that from "we looked and there is nothing".
    const res = await post(`/v1/projects/${projectId}/search`, {
      query: "how should the core package be structured",
      mode: "semantic",
    });

    const found = (await res.json()) as { items: unknown[]; skipped: string[] };
    expect(found.items).toEqual([]);
    expect(found.skipped).toContain("dense");
  });

  it("honours the limit the caller asked for", async () => {
    // A trigram query, because it matches on substrings rather than on a
    // conjunction of lexemes — see the test below for why that matters.
    const res = await post(`/v1/projects/${projectId}/search`, {
      query: "packages/core",
      mode: "lexical",
      limit: 1,
    });

    const found = (await res.json()) as {
      items: unknown[];
      returned: number;
      truncated: boolean;
      total: number;
    };
    expect(found.items).toHaveLength(1);
    expect(found.returned).toBe(1);
    if (found.total > 1) expect(found.truncated).toBe(true);
  });

  /**
   * The shape of generator 2, recorded because it surprises people.
   *
   * `websearch_to_tsquery` ANDs unquoted words, so a query matches an atom only
   * if the atom contains **every** word in it. Two words that genuinely
   * co-occur find their atom; four words scattered across three atoms find
   * nothing, and nothing errors — the generator returns an empty list and
   * fusion carries on with the others.
   *
   * That is the documented parser (`docs/06-retrieval.md`), and it is why
   * generator 3 keeps identifiers whole and why `lexicalQuery` stopped
   * expanding them: under a conjunction, extra terms are extra obligations.
   * Whether a long task description should instead be ORed is a ranking
   * question for the corpus, not something to decide here.
   */
  it("requires every word of a lexical query to appear in one atom", async () => {
    const both = await post(`/v1/projects/${projectId}/search`, {
      query: "migration reversible",
      mode: "lexical",
    });
    const scattered = await post(`/v1/projects/${projectId}/search`, {
      query: "migration postgres pure",
      mode: "lexical",
    });

    expect(((await both.json()) as { items: unknown[] }).items.length).toBe(1);
    // Each of those words is in the project. No single atom holds all three.
    expect(((await scattered.json()) as { items: unknown[] }).items).toEqual(
      [],
    );
  });

  it("refuses an empty query rather than searching for everything", async () => {
    const res = await post(`/v1/projects/${projectId}/search`, { query: "" });

    expect(res.status).toBe(400);
  });
});
