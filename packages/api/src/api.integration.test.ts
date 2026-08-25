import { closePool, generateApiKey } from "@standfast/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * The HTTP boundary, tested adversarially.
 *
 * The app is pointed at the unprivileged `standfast_test` role: as the superuser
 * every isolation assertion would pass while proving nothing, because
 * superusers bypass row-level security outright.
 */

const adminUrl = process.env["DATABASE_URL"] ?? "";
const app = createApp();

let humanKey = "";
let agentKey = "";
let revokedKey = "";
let orgBProjectId = "";
let orgAId = "";
let projectId = "";

async function admin(): Promise<Client> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  return client;
}

async function seed(): Promise<void> {
  const db = await admin();
  try {
    await db.query(`DO $$ BEGIN
      CREATE ROLE standfast_test LOGIN PASSWORD 'standfast_test' NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await db.query('GRANT "standfast_app" TO standfast_test');

    const suffix = `${Date.now()}-${process.pid}`;
    const org = async (slug: string) =>
      (
        await db.query<{ id: string }>(
          "insert into orgs (name, slug) values ($1, $1) returning id",
          [`${slug}-${suffix}`],
        )
      ).rows[0]?.id ?? "";

    const orgA = await org("api-a");
    orgAId = orgA;
    const orgB = await org("api-b");

    // Production creates this with the org (bootstrap.ts, migration 0004), so a
    // test that creates an org creates one too. putDocument resolves it to
    // attribute extraction jobs, and deliberately refuses to mint one itself.
    for (const id of [orgA, orgB]) {
      await db.query(
        "insert into actors (org_id, kind, display_name, system_key) values ($1, 'agent', 'Extractor', 'extractor')",
        [id],
      );
    }

    const actor = async (orgId: string, kind: "human" | "agent") =>
      (
        await db.query<{ id: string }>(
          // Separate placeholders: reusing one for the enum column and the
          // text column makes Postgres deduce two types for it and refuse.
          "insert into actors (org_id, kind, display_name) values ($1, $2, $3) returning id",
          [orgId, kind, kind],
        )
      ).rows[0]?.id ?? "";

    const human = await actor(orgA, "human");
    const agent = await actor(orgA, "agent");

    const key = async (
      orgId: string,
      actorId: string,
      revoked: boolean,
    ): Promise<string> => {
      const generated = generateApiKey();
      await db.query(
        `insert into api_keys (org_id, actor_id, prefix, hash, scopes, revoked_at)
         values ($1, $2, $3, $4, ARRAY['read','write'], $5)`,
        [
          orgId,
          actorId,
          `${generated.prefix}-${Math.random()}`,
          generated.hash,
          revoked ? new Date() : null,
        ],
      );
      return generated.key;
    };

    humanKey = await key(orgA, human, false);
    agentKey = await key(orgA, agent, false);
    revokedKey = await key(orgA, human, true);

    const projectB = await db.query<{ id: string }>(
      "insert into projects (org_id, name, slug) values ($1, 'B', 'b') returning id",
      [orgB],
    );
    orgBProjectId = projectB.rows[0]?.id ?? "";
  } finally {
    await db.end();
  }

  // Only now point the app at the unprivileged role.
  const url = new URL(adminUrl);
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
}

const call = (path: string, key: string | null, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  await closePool();
  process.env["DATABASE_URL"] = adminUrl;
});

describe("authentication", () => {
  it("rejects a request with no key", async () => {
    expect((await call("/v1/projects", null)).status).toBe(401);
  });

  it("rejects an unknown key", async () => {
    expect((await call("/v1/projects", "sf_sk_nope")).status).toBe(401);
  });

  // Revocation is enforced by the policy behind auth.resolve_api_key, not by
  // application code that could later be reordered.
  it("rejects a revoked key", async () => {
    expect((await call("/v1/projects", revokedKey)).status).toBe(401);
  });

  it("leaves /health open", async () => {
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("tenant isolation over HTTP", () => {
  it("accepts a valid key", async () => {
    const res = await call("/v1/projects", humanKey);
    expect(res.status).toBe(200);
    // An empty page, not a bare empty array. The envelope is the same shape
    // whether or not there is anything in it, so a client never has to branch
    // on emptiness to find out whether more exists.
    expect(await res.json()).toEqual({
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
    });
  });

  // 403 would confirm the project exists. Not-found and not-yours have to be
  // indistinguishable from outside.
  it("answers 404, not 403, for another org's project", async () => {
    const res = await call(`/v1/projects/${orgBProjectId}`, humanKey);
    expect(res.status).toBe(404);
  });
});

describe("projects and documents", () => {
  it("creates a project", async () => {
    const res = await call("/v1/projects", humanKey, {
      method: "POST",
      body: JSON.stringify({ name: "Standfast", slug: "standfast" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; slug: string };
    projectId = body.id;
    expect(body.slug).toBe("standfast");
  });

  it("rejects a duplicate slug with 409", async () => {
    const res = await call("/v1/projects", humanKey, {
      method: "POST",
      body: JSON.stringify({ name: "Standfast", slug: "standfast" }),
    });
    expect(res.status).toBe(409);
  });

  it("derives sections from the body on write", async () => {
    const put = await call(`/v1/projects/${projectId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({
        path: "docs/a.md",
        body: "# One\nalpha\n\n# Two\nbeta",
      }),
    });
    expect(put.status).toBe(200);
    const doc = (await put.json()) as { id: string };

    const res = await call(`/v1/documents/${doc.id}/sections`, humanKey);
    const sections = (await res.json()) as {
      items: { headingPath: string[] }[];
      total: number;
      truncated: boolean;
    };
    expect(sections.items.map((s) => s.headingPath)).toEqual([
      ["One"],
      ["Two"],
    ]);
    // Two sections, both on the page, so nothing was dropped and the flag says
    // so. A flag that is always true is one nobody reads.
    expect(sections.total).toBe(2);
    expect(sections.truncated).toBe(false);
  });

  it("replaces sections rather than accumulating them", async () => {
    const put = await call(`/v1/projects/${projectId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: "docs/a.md", body: "# Only\nsolo" }),
    });
    const doc = (await put.json()) as { id: string };

    const res = await call(`/v1/documents/${doc.id}/sections`, humanKey);
    const sections = (await res.json()) as {
      items: { headingPath: string[] }[];
    };
    expect(sections.items).toHaveLength(1);
    expect(sections.items[0]?.headingPath).toEqual(["Only"]);
  });
});

describe("document manifest", () => {
  let manifestProjectId = "";
  const paths = ["docs/a.md", "docs/b.md", "docs/c.md"];

  it("serves (id, path, contentHash) and nothing else", async () => {
    const created = await call("/v1/projects", humanKey, {
      method: "POST",
      body: JSON.stringify({ name: "Manifest", slug: "manifest" }),
    });
    expect(created.status).toBe(201);
    manifestProjectId = ((await created.json()) as { id: string }).id;

    for (const path of paths) {
      const put = await call(
        `/v1/projects/${manifestProjectId}/documents`,
        humanKey,
        {
          method: "PUT",
          body: JSON.stringify({
            path,
            title: "Titled",
            body: `# ${path}\ncontent of ${path}`,
          }),
        },
      );
      expect(put.status).toBe(200);
    }

    const res = await call(
      `/v1/projects/${manifestProjectId}/documents/manifest`,
      humanKey,
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: Record<string, unknown>[];
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(page.total).toBe(3);
    expect(page.returned).toBe(3);
    expect(page.truncated).toBe(false);
    expect(page.items.map((item) => item["path"])).toEqual(paths);
    for (const item of page.items) {
      // The keys are absent, not empty: a `body: ""` would still put every
      // document body's slot on the wire, and `"body" in item` must be false.
      expect(Object.keys(item).sort()).toEqual(["contentHash", "id", "path"]);
      expect("body" in item).toBe(false);
      expect("title" in item).toBe(false);
      expect(typeof item["contentHash"]).toBe("string");
      expect(item["contentHash"]).not.toBe("");
    }
  });

  it("paginates across a page boundary", async () => {
    const first = await call(
      `/v1/projects/${manifestProjectId}/documents/manifest?limit=2`,
      humanKey,
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      items: { path: string }[];
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(page1.total).toBe(3);
    expect(page1.returned).toBe(2);
    expect(page1.truncated).toBe(true);
    expect(page1.items.map((item) => item.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);

    const second = await call(
      `/v1/projects/${manifestProjectId}/documents/manifest?limit=2&offset=2`,
      humanKey,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as {
      items: { path: string }[];
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(page2.total).toBe(3);
    expect(page2.returned).toBe(1);
    expect(page2.truncated).toBe(false);
    expect(page2.items.map((item) => item.path)).toEqual(["docs/c.md"]);
  });

  it("answers 404 for an unknown project and another org's alike", async () => {
    const nonexistent = await call(
      "/v1/projects/00000000-0000-0000-0000-000000000000/documents/manifest",
      humanKey,
    );
    expect(nonexistent.status).toBe(404);
    expect(await nonexistent.json()).toEqual({ error: "Not found." });

    // 403 — or an empty page — would confirm the project exists. Not-found
    // and not-yours have to be indistinguishable from outside.
    const cross = await call(
      `/v1/projects/${orgBProjectId}/documents/manifest`,
      humanKey,
    );
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({ error: "Not found." });
  });
});

describe("atoms", () => {
  let atomId = "";

  const firstSection = async () => {
    const put = await call(`/v1/projects/${projectId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: "docs/b.md", body: "# Rule\nAlways ship." }),
    });
    const doc = (await put.json()) as { id: string };
    const res = await call(`/v1/documents/${doc.id}/sections`, humanKey);
    const sections = (await res.json()) as { items: { id: string }[] };
    return { documentId: doc.id, sectionId: sections.items[0]?.id ?? "" };
  };

  it("creates an atom as provisional even when the client asks otherwise", async () => {
    const { documentId, sectionId } = await firstSection();
    const res = await call(`/v1/projects/${projectId}/atoms`, agentKey, {
      method: "POST",
      body: JSON.stringify({
        documentId,
        sectionId,
        statement: "Always ship.",
        kind: "convention",
        // The span is an offset into the *section* body, and a section body
        // includes its heading line — so "Always ship." starts after "# Rule\n".
        sourceQuote: "Always ship.",
        sourceSpan: { start: 7, end: 19 },
        // Not in the request schema, so it cannot take effect. Asserted
        // rather than assumed.
        status: "canonical",
      }),
    });

    expect(res.status).toBe(201);
    const atom = (await res.json()) as { id: string; status: string };
    atomId = atom.id;
    expect(atom.status).toBe("provisional");
  });

  /**
   * The span is Unicode **code points**, and this is the test that says so.
   *
   * `packages/core/src/markdown.ts` counts them that way and Postgres
   * `substring` agrees, but a JavaScript client reaching for `indexOf` gets
   * UTF-16 code units and is wrong on any document containing an emoji, a CJK
   * character outside the BMP, or — far more commonly — nothing at all until
   * the one document that does. Putting a non-BMP character *before* the quote
   * is what makes the two numbers differ, so the assertion can tell them apart.
   */
  it("returns the span in code points, not UTF-16 units or bytes", async () => {
    const quote = "Retries use backoff.";
    const body = `# Heading\n\u{1F600} ${quote}`;

    // Code points, by construction: spreading a string iterates code points,
    // while `.length` and `.indexOf` count UTF-16 units.
    const codePoints = [...body];
    const start = codePoints.findIndex((_, i) =>
      codePoints.slice(i).join("").startsWith(quote),
    );
    const end = start + [...quote].length;

    // The two numbers genuinely differ here, or the test proves nothing.
    expect(body.indexOf(quote)).not.toBe(start);

    const put = await call(`/v1/projects/${projectId}/documents`, humanKey, {
      method: "PUT",
      body: JSON.stringify({ path: "docs/emoji.md", body }),
    });
    const doc = (await put.json()) as { id: string };
    const sections = (await (
      await call(`/v1/documents/${doc.id}/sections`, humanKey)
    ).json()) as { items: { id: string }[] };

    const res = await call(`/v1/projects/${projectId}/atoms`, agentKey, {
      method: "POST",
      body: JSON.stringify({
        documentId: doc.id,
        sectionId: sections.items[0]?.id,
        statement: quote,
        kind: "convention",
        sourceQuote: quote,
        sourceSpan: { start, end },
      }),
    });

    // The database verifies the quote against the section body at this span on
    // the way in, so a 201 is itself the proof that the offsets are the ones
    // Postgres counts with.
    expect(res.status).toBe(201);
    const atom = (await res.json()) as {
      id: string;
      sourceSpan: { start: number; end: number };
    };
    expect(atom.sourceSpan).toEqual({ start, end });

    // And it survives the read path unchanged, rather than being re-derived.
    const back = (await (
      await call(`/v1/atoms/${atom.id}`, humanKey)
    ).json()) as { sourceSpan: { start: number; end: number } };
    expect(back.sourceSpan).toEqual({ start, end });
  });

  it("refuses ratification by an agent", async () => {
    const res = await call(`/v1/atoms/${atomId}/ratify`, agentKey, {
      method: "POST",
    });
    expect(res.status).toBe(403);

    const after = await call(`/v1/atoms/${atomId}`, humanKey);
    expect(((await after.json()) as { status: string }).status).toBe(
      "provisional",
    );
  });

  it("allows ratification by a human", async () => {
    const res = await call(`/v1/atoms/${atomId}/ratify`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const atom = (await res.json()) as {
      status: string;
      ratifiedBy: string | null;
    };
    expect(atom.status).toBe("canonical");
    expect(atom.ratifiedBy).not.toBeNull();
  });

  it("refuses to ratify twice", async () => {
    const res = await call(`/v1/atoms/${atomId}/ratify`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("rejects an atom whose provenance quote is blank", async () => {
    const { documentId, sectionId } = await firstSection();
    const res = await call(`/v1/projects/${projectId}/atoms`, humanKey, {
      method: "POST",
      body: JSON.stringify({
        documentId,
        sectionId,
        statement: "x",
        kind: "decision",
        sourceQuote: "",
        sourceSpan: { start: 0, end: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * The read side of the disclosure record.
 *
 * There is no route that writes one — the worker does, before each outbound
 * call — so the fixture inserts through a superuser connection, which is also
 * the shape of the question these tests answer: given rows in the table, can
 * the tenant read theirs and only theirs.
 */
describe("egress", () => {
  let egressProjectId = "";

  const insert = async (
    orgId: string,
    project: string,
    model: string,
    chars: number,
  ): Promise<void> => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(
        `insert into egress_events
           (org_id, project_id, purpose, destination, model, input_items, input_chars)
         values ($1, $2, 'extraction', 'https://api.example.com', $3, 1, $4)`,
        [orgId, project, model, chars],
      );
    } finally {
      await admin.end();
    }
  };

  beforeAll(async () => {
    const res = await call("/v1/projects", humanKey, {
      method: "POST",
      body: JSON.stringify({ name: "Egress", slug: "egress" }),
    });
    egressProjectId = ((await res.json()) as { id: string }).id;

    await insert(orgAId, egressProjectId, "some-model-2026-01-01", 4_096);
    await insert(orgAId, egressProjectId, "some-model-2026-06-01", 100);
  });

  it("answers what left, to whom, and as which model", async () => {
    const res = await call(`/v1/projects/${egressProjectId}/egress`, humanKey);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      model: string;
      calls: number;
      chars: number;
    }>;

    // Two rows, not one summed row. A deployment that moved its pin sent two
    // different models, and the pin is worthless if the disclosure averages it.
    expect(rows.map((r) => r.model)).toEqual([
      "some-model-2026-01-01",
      "some-model-2026-06-01",
    ]);
    expect(rows.map((r) => r.chars)).toEqual([4_096, 100]);
  });

  it("lists the individual calls, most recent first", async () => {
    const res = await call(
      `/v1/projects/${egressProjectId}/egress/events?limit=1`,
      humanKey,
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: Array<{ inputChars: number }>;
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.inputChars).toBe(100);
    // One of two, asked for by the caller. `total` counts what matched, not
    // what came back, and `truncated` is how the caller learns there is more —
    // never by comparing the two numbers itself.
    expect(page.total).toBe(2);
    expect(page.returned).toBe(1);
    expect(page.truncated).toBe(true);
  });

  it("carries a size and never a sample", async () => {
    const res = await call(
      `/v1/projects/${egressProjectId}/egress/events`,
      humanKey,
    );
    const rows = ((await res.json()) as { items: Record<string, unknown>[] })
      .items;
    // The assertion is on the key set. A field that could hold what was sent
    // fails here before it reaches anyone's deployment.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "at",
      "destination",
      "id",
      "inputChars",
      "inputItems",
      "model",
      "projectId",
      "purpose",
      "sectionId",
    ]);
  });

  it("is empty for another org's project", async () => {
    const res = await call(`/v1/projects/${orgBProjectId}/egress`, humanKey);
    // 200 with nothing, not 404: the project id is not the caller's to
    // confirm, and RLS answers "no rows" for exactly the same reason.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

/**
 * Phase 3. The moat, and the one path where an agent that has just read source
 * is asked to say something about it.
 *
 * These tests are about the boundary rather than the loop: what the route
 * accepts, who it refuses, and what it hands back. The constraints themselves
 * live in the database and are exercised in
 * `packages/db/src/testing/reconciliation.integration.test.ts`; the shape of the
 * request is pinned without a database in `reconcile-schema.test.ts`, which is
 * where exit criterion 2 is asserted.
 */
describe("reconciliation", () => {
  let reconcileProjectId = "";
  let reconcileAtomId = "";

  const submit = async (key: string, body: unknown): Promise<Response> =>
    call(`/v1/projects/${reconcileProjectId}/reconciliations`, key, {
      method: "POST",
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const project = (await (
      await call("/v1/projects", humanKey, {
        method: "POST",
        body: JSON.stringify({ name: "Reconcile", slug: "reconcile" }),
      })
    ).json()) as { id: string };
    reconcileProjectId = project.id;

    const doc = (await (
      await call(`/v1/projects/${reconcileProjectId}/documents`, humanKey, {
        method: "PUT",
        body: JSON.stringify({
          path: "docs/decisions.md",
          body: "# Retries\nRetries use exponential backoff.",
        }),
      })
    ).json()) as { id: string };

    const sections = (await (
      await call(`/v1/documents/${doc.id}/sections`, humanKey)
    ).json()) as { items: { id: string }[] };

    const atom = (await (
      await call(`/v1/projects/${reconcileProjectId}/atoms`, agentKey, {
        method: "POST",
        body: JSON.stringify({
          documentId: doc.id,
          sectionId: sections.items[0]?.id,
          kind: "convention",
          statement: "Retries use exponential backoff.",
          // The span is an offset into the section body, which includes its
          // heading line — so the sentence starts after "# Retries\n".
          sourceQuote: "Retries use exponential backoff.",
          sourceSpan: { start: 10, end: 42 },
        }),
      })
    ).json()) as { id: string };
    reconcileAtomId = atom.id;

    // Canonical, so that `canonicalUnchecked` has something to count. Only a
    // human can do this, which is the point of the ratify route.
    await call(`/v1/atoms/${reconcileAtomId}/ratify`, humanKey, {
      method: "POST",
    });
  });

  it("refuses an unauthenticated submission", async () => {
    const res = await call(
      `/v1/projects/${reconcileProjectId}/reconciliations`,
      "",
      { method: "POST", body: JSON.stringify({ items: [] }) },
    );
    expect(res.status).toBe(401);
  });

  // 404 and never 403: telling a caller that a project exists in another org is
  // the leak, and the status code is where it would happen.
  it("does not admit that another org's project exists", async () => {
    const res = await call(
      `/v1/projects/${orgBProjectId}/reconciliations`,
      humanKey,
      {
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              atomId: reconcileAtomId,
              verdict: "honored",
              filePath: "src/a.ts",
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("refuses a field that could carry source code", async () => {
    const res = await submit(agentKey, {
      items: [
        {
          atomId: reconcileAtomId,
          verdict: "honored",
          filePath: "src/a.ts",
          snippet: "export function f() { return 1; }",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("refuses a violation that cites no lines", async () => {
    const res = await submit(agentKey, {
      items: [
        {
          atomId: reconcileAtomId,
          verdict: "violated",
          filePath: "src/a.ts",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("records a run and queues exactly the violation", async () => {
    const res = await submit(agentKey, {
      trigger: "post_edit",
      items: [
        {
          atomId: reconcileAtomId,
          verdict: "violated",
          filePath: "src/retry.ts",
          lineStart: 12,
          lineEnd: 14,
          rationale: "Fixed 100ms sleep between attempts.",
        },
        {
          atomId: reconcileAtomId,
          verdict: "honored",
          filePath: "src/other.ts",
        },
        {
          atomId: reconcileAtomId,
          verdict: "not_applicable",
          filePath: "src/types.ts",
        },
      ],
    });

    expect(res.status).toBe(201);
    const ack = (await res.json()) as {
      runId: string;
      recorded: number;
      open: number;
    };
    expect(ack.recorded).toBe(3);
    expect(ack.open).toBe(1);
  });

  it("serves the queue without ever serving the rationale", async () => {
    const res = await call(
      `/v1/projects/${reconcileProjectId}/findings?status=open`,
      humanKey,
    );
    expect(res.status).toBe(200);

    const page = (await res.json()) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(page.items.length).toBe(1);

    const finding = page.items[0];
    expect(finding?.["verdict"]).toBe("violated");
    // Asserted on the key set, so that widening the serialised shape fails here
    // rather than quietly making the one free-text field on this path readable
    // by the next agent that lists findings.
    expect(Object.keys(finding ?? {})).not.toContain("rationale");
    expect(Object.keys(finding ?? {})).not.toContain("orgId");
  });

  it("keeps non-violations out of the queue", async () => {
    const page = (await (
      await call(
        `/v1/projects/${reconcileProjectId}/findings?status=recorded`,
        humanKey,
      )
    ).json()) as { items: { verdict: string }[] };

    expect(page.items.length).toBe(2);
    expect(page.items.every((f) => f.verdict !== "violated")).toBe(true);
  });

  it("surfaces the open finding through status", async () => {
    const stats = (await (
      await call(`/v1/projects/${reconcileProjectId}/atoms/stats`, humanKey)
    ).json()) as { openFindings: number; canonicalUnchecked: number };

    expect(stats.openFindings).toBe(1);
    /**
     * The atom was checked after it was ratified, so nothing is unchecked.
     *
     * This line is the regression test for a mixed-clock defect, and it is
     * deliberately written the natural way — ratify, then record, then ask —
     * rather than pinning either timestamp. `ratifyAtom` used to stamp
     * `ratified_at` from the application clock while a finding's `created_at`
     * comes from `now()` in Postgres; on a host running a few tens of
     * milliseconds ahead of the database, a finding recorded *after* a
     * ratification landed *before* it and the atom stayed counted as unchecked.
     * Both sides now come from the database clock. A unit test that pins the
     * instants cannot see that class of bug, which is precisely why this one
     * does not.
     */
    expect(stats.canonicalUnchecked).toBe(0);
  });

  it("refuses an agent resolving a finding about its own edit", async () => {
    const page = (await (
      await call(
        `/v1/projects/${reconcileProjectId}/findings?status=open`,
        humanKey,
      )
    ).json()) as { items: { id: string }[] };
    const findingId = page.items[0]?.id;

    const res = await call(`/v1/findings/${findingId}/resolve`, agentKey, {
      method: "POST",
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(403);
  });

  it("lets a human answer once, and only once", async () => {
    const page = (await (
      await call(
        `/v1/projects/${reconcileProjectId}/findings?status=open`,
        humanKey,
      )
    ).json()) as { items: { id: string }[] };
    const findingId = page.items[0]?.id;

    const first = await call(`/v1/findings/${findingId}/resolve`, humanKey, {
      method: "POST",
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(first.status).toBe(200);
    const resolved = (await first.json()) as {
      status: string;
      resolvedAt: string | null;
    };
    expect(resolved.status).toBe("dismissed");
    expect(resolved.resolvedAt).not.toBeNull();

    // No reopen transition exists, so the second answer is a conflict rather
    // than an overwrite. A dismissed finding is the numerator of this product's
    // own kill metric; it does not get to be edited afterwards.
    const second = await call(`/v1/findings/${findingId}/resolve`, humanKey, {
      method: "POST",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(second.status).toBe(409);
  });

  it("empties the queue once the human has answered", async () => {
    const stats = (await (
      await call(`/v1/projects/${reconcileProjectId}/atoms/stats`, humanKey)
    ).json()) as { openFindings: number };
    expect(stats.openFindings).toBe(0);
  });
});

/**
 * Phase 4a. The bottleneck this product exists to move: a human reading
 * provisional atoms and saying yes, no, or not any more.
 *
 * Three projects rather than one, because every number on this surface is
 * project-wide. A rejection in one test would silently move a backlog assertion
 * in another, and the test that broke would be the one that was still right.
 *
 * The database's own guarantees — that only a human can write a terminal event,
 * that a supersede is one transaction or none — live in
 * `packages/db/src/testing/ratification.integration.test.ts`. What is asserted
 * here is the boundary: who the routes refuse, which status code says so, and
 * what a reviewer is actually handed.
 */
describe("ratification", () => {
  // One body for every project below, so a span is `indexOf` and the arithmetic
  // stays readable. Deliberately ASCII: code points and UTF-16 units agree
  // here, which is what makes `indexOf` legitimate at all — the case where they
  // come apart is pinned by the emoji test in the atoms block above.
  const BODY = [
    "# Operations",
    "Logs are retained for thirty days.",
    "Backups are encrypted at rest.",
    "Deploys are announced in advance.",
    "Errors are reported to the on-call engineer.",
    "Metrics are sampled once a second.",
    "Dashboards are reviewed every Monday.",
    "Alerts page the on-call rota.",
    "Runbooks live beside the service.",
    "Postmortems are written within a week.",
  ].join("\n");

  type Fixture = {
    projectId: string;
    documentId: string;
    sectionId: string;
  };

  let decide: Fixture;
  let queue: Fixture;
  // No document and no atoms. The throughput metric has to answer for a project
  // nobody has proposed anything in yet, and that is a different question from
  // "nothing has been decided *lately*".
  let quietProjectId = "";
  let orgBAtomId = "";

  /** A project holding one document whose single section is `BODY` entire. */
  const seed = async (slug: string): Promise<Fixture> => {
    const project = (await (
      await call("/v1/projects", humanKey, {
        method: "POST",
        body: JSON.stringify({ name: slug, slug }),
      })
    ).json()) as { id: string };

    const doc = (await (
      await call(`/v1/projects/${project.id}/documents`, humanKey, {
        method: "PUT",
        body: JSON.stringify({ path: "docs/operations.md", body: BODY }),
      })
    ).json()) as { id: string };

    const sections = (await (
      await call(`/v1/documents/${doc.id}/sections`, humanKey)
    ).json()) as { items: { id: string }[] };

    return {
      projectId: project.id,
      documentId: doc.id,
      sectionId: sections.items[0]?.id ?? "",
    };
  };

  /**
   * An agent proposes; that is the only way an atom is born. The span is an
   * offset into the section body, which for a single-heading document is the
   * document body — so `indexOf` against `BODY` is the same number Postgres
   * checks the quote against on the way in.
   */
  const propose = async (
    fixture: Fixture,
    sentence: string,
    kind: "decision" | "convention" | "constraint",
  ): Promise<string> => {
    const start = BODY.indexOf(sentence);
    const res = await call(
      `/v1/projects/${fixture.projectId}/atoms`,
      agentKey,
      {
        method: "POST",
        body: JSON.stringify({
          documentId: fixture.documentId,
          sectionId: fixture.sectionId,
          statement: sentence,
          kind,
          sourceQuote: sentence,
          sourceSpan: { start, end: start + sentence.length },
        }),
      },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const statusOf = async (atomId: string): Promise<string> =>
    (
      (await (await call(`/v1/atoms/${atomId}`, humanKey)).json()) as {
        status: string;
      }
    ).status;

  // Every atom the decision tests need, named for what is done to it. Declared
  // together because the order they are proposed in is the order the queue
  // serves them, and that ordering is itself under test further down.
  let rejectedWithReasonId = "";
  let rejectedBareId = "";
  /**
   * The atom nothing may move. Every refusal — the three 400s, the agent's 403,
   * the 409 for retiring something that was never canonical — is asserted
   * against this one row, so that a route which silently succeeded would be
   * caught by the next test in the list rather than by nobody.
   */
  let untouchedId = "";
  let retiredId = "";
  let incumbentId = "";
  let successorId = "";
  let neverCanonicalId = "";
  let blockedCandidateId = "";
  let strayCandidateId = "";
  const queueIds: string[] = [];
  let queueCanonicalId = "";

  beforeAll(async () => {
    decide = await seed("ratify-decide");
    queue = await seed("ratify-queue");

    quietProjectId = (
      (await (
        await call("/v1/projects", humanKey, {
          method: "POST",
          body: JSON.stringify({ name: "ratify-quiet", slug: "ratify-quiet" }),
        })
      ).json()) as { id: string }
    ).id;

    rejectedWithReasonId = await propose(
      decide,
      "Logs are retained for thirty days.",
      "decision",
    );
    rejectedBareId = await propose(
      decide,
      "Backups are encrypted at rest.",
      "convention",
    );
    untouchedId = await propose(
      decide,
      "Deploys are announced in advance.",
      "constraint",
    );
    retiredId = await propose(
      decide,
      "Errors are reported to the on-call engineer.",
      "decision",
    );
    incumbentId = await propose(
      decide,
      "Metrics are sampled once a second.",
      "convention",
    );
    successorId = await propose(
      decide,
      "Dashboards are reviewed every Monday.",
      "convention",
    );
    neverCanonicalId = await propose(
      decide,
      "Alerts page the on-call rota.",
      "decision",
    );
    blockedCandidateId = await propose(
      decide,
      "Runbooks live beside the service.",
      "decision",
    );
    strayCandidateId = await propose(
      decide,
      "Postmortems are written within a week.",
      "decision",
    );

    // Proposed one at a time and in this order: the queue is FIFO on arrival,
    // and a batch insert would leave the three sharing a transaction timestamp
    // and the ordering assertion proving only that the tie-break is stable.
    for (const [sentence, kind] of [
      ["Logs are retained for thirty days.", "decision"],
      ["Backups are encrypted at rest.", "convention"],
      ["Deploys are announced in advance.", "constraint"],
    ] as const) {
      queueIds.push(await propose(queue, sentence, kind));
    }

    // A canonical atom in the queue's project, so that "the queue is the
    // provisional atoms" is asserted against a project that has something else
    // to show. It doubles as the incumbent a cross-project supersede aims at.
    queueCanonicalId = await propose(
      queue,
      "Metrics are sampled once a second.",
      "convention",
    );
    await call(`/v1/atoms/${queueCanonicalId}/ratify`, humanKey, {
      method: "POST",
    });

    // Org B, written through the superuser: there is no key for that org in
    // this file, and the point of the fixture is that org A's key cannot reach
    // this row by any route. A real row rather than a random UUID, because
    // "not found" and "not yours" have to be indistinguishable and only an atom
    // that genuinely exists can tell the two answers apart.
    const db = new Client({ connectionString: adminUrl });
    await db.connect();
    try {
      const orgB = (
        await db.query<{ org_id: string }>(
          "select org_id from projects where id = $1",
          [orgBProjectId],
        )
      ).rows[0]?.org_id;

      const documentId = (
        await db.query<{ id: string }>(
          `insert into documents (org_id, project_id, path, body, content_hash)
           values ($1, $2, 'docs/operations.md', $3, 'b') returning id`,
          [orgB, orgBProjectId, BODY],
        )
      ).rows[0]?.id;

      const sectionId = (
        await db.query<{ id: string }>(
          `insert into document_sections
             (org_id, document_id, ordinal, heading_path, body, section_hash)
           values ($1, $2, 0, ARRAY['Operations'], $3, 'b') returning id`,
          [orgB, documentId, BODY],
        )
      ).rows[0]?.id;

      const sentence = "Logs are retained for thirty days.";
      const start = BODY.indexOf(sentence);
      orgBAtomId =
        (
          await db.query<{ id: string }>(
            `insert into atoms
               (org_id, project_id, document_id, section_id, statement, kind,
                status, source_quote, source_span)
             values ($1, $2, $3, $4, $5, 'decision', 'provisional', $6, $7::int4range)
             returning id`,
            [
              orgB,
              orgBProjectId,
              documentId,
              sectionId,
              sentence,
              sentence,
              `[${start},${start + sentence.length})`,
            ],
          )
        ).rows[0]?.id ?? "";
    } finally {
      await db.end();
    }
  });

  it("records a rejection with the reason and the note the reviewer wrote", async () => {
    const res = await call(
      `/v1/atoms/${rejectedWithReasonId}/reject`,
      humanKey,
      {
        method: "POST",
        body: JSON.stringify({
          reason: "duplicate",
          reasonNote: "The retention rule is already canonical.",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("rejected");
  });

  /**
   * The cheap decision, and it has to stay cheap. A reviewer who is made to
   * justify every rejection ratifies the marginal atoms instead, which is the
   * exact failure `docs/15-ratification.md` is written against — so a bodyless
   * `POST` is the common path, not a degenerate one.
   *
   * Sent through `app.request` rather than `call`, and that is the point of the
   * test as much as the status code is. `call` always sets
   * `content-type: application/json`, and an empty body under that header is a
   * parse error before the route is reached — the same trap that moved
   * `supersedes` onto the query string. A client with nothing to say sends no
   * content type.
   */
  it("accepts a rejection with no body at all", async () => {
    const res = await app.request(`/v1/atoms/${rejectedBareId}/reject`, {
      method: "POST",
      headers: { authorization: `Bearer ${humanKey}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("rejected");
  });

  /**
   * The free half of the reason, bounded. 280 characters is the same cap the
   * reconciliation rationale carries, so this system has one number for free
   * text rather than two, and the boundary is asserted from the outside where a
   * schema change would show up.
   */
  it("refuses a note of 281 characters", async () => {
    const res = await call(`/v1/atoms/${untouchedId}/reject`, humanKey, {
      method: "POST",
      body: JSON.stringify({ reasonNote: "x".repeat(281) }),
    });
    expect(res.status).toBe(400);
  });

  // Absent and empty are different answers. An empty string is a note the
  // reviewer did not write, and storing one would put a row into the labelled
  // corpus that says nothing while looking as though it does.
  it("refuses a blank note", async () => {
    const res = await call(`/v1/atoms/${untouchedId}/reject`, humanKey, {
      method: "POST",
      body: JSON.stringify({ reasonNote: "" }),
    });
    expect(res.status).toBe(400);
  });

  // The vocabulary is closed because its whole value is comparability across
  // projects. A reason nobody else records is a reason nobody can count.
  it("refuses a reason outside the vocabulary", async () => {
    const res = await call(`/v1/atoms/${untouchedId}/reject`, humanKey, {
      method: "POST",
      body: JSON.stringify({ reason: "because" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a rejection by an agent, and the atom does not move", async () => {
    const res = await call(`/v1/atoms/${untouchedId}/reject`, agentKey, {
      method: "POST",
      body: JSON.stringify({ reason: "not_true" }),
    });
    expect(res.status).toBe(403);
    expect(await statusOf(untouchedId)).toBe("provisional");
  });

  // Terminal, because re-extraction matches against existing rows: a rejection
  // that could be taken back would re-propose itself every run.
  it("refuses to reject twice", async () => {
    const res = await call(
      `/v1/atoms/${rejectedWithReasonId}/reject`,
      humanKey,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(409);
  });

  /**
   * The tenancy boundary.
   *
   * 404, and never 403: a 403 would confirm that org A's key had found
   * something, which is the leak. 404 is the same answer an id that never
   * existed gets, so it discloses nothing — the read is scoped by row-level
   * security, and an atom in another org simply is not there.
   *
   * This test previously asserted only that the answer was *indistinguishable*
   * from "already decided", because the route merged the two into one 409. It
   * no longer does: an atom the caller cannot see and an atom that has already
   * been decided are different facts, and a caller acting in good faith should
   * be told which one it hit. The security property is unchanged — that is what
   * the second assertion below pins.
   */
  it("does not admit that another org's atom exists", async () => {
    const cross = await call(`/v1/atoms/${orgBAtomId}/reject`, humanKey, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(cross.status).toBe(404);

    // Indistinguishable from an id that was never issued, which is what makes
    // 404 disclose nothing.
    const nonexistent = await call(
      "/v1/atoms/00000000-0000-0000-0000-000000000000/reject",
      humanKey,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(nonexistent.status).toBe(404);
    expect(await cross.json()).toEqual(await nonexistent.json());

    // And nothing happened to it.
    const db = new Client({ connectionString: adminUrl });
    await db.connect();
    try {
      const row = await db.query<{ status: string }>(
        "select status from atoms where id = $1",
        [orgBAtomId],
      );
      expect(row.rows[0]?.status).toBe("provisional");
    } finally {
      await db.end();
    }
  });

  // Bodyless, and it has to stay that way: ratification was a bodyless POST
  // before `supersedes` existed and every client still sends it that way. This
  // is the guard that fails loudly if the route ever grows a required body.
  it("ratifies with no body and no query", async () => {
    const res = await call(`/v1/atoms/${retiredId}/ratify`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("canonical");
  });

  it("refuses to retire an atom that was never canonical", async () => {
    const res = await call(`/v1/atoms/${untouchedId}/retire`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect(await statusOf(untouchedId)).toBe("provisional");
  });

  // Withdrawing a decision the project made is not an agent's call, and the
  // check runs before the status check so the refusal names the real reason.
  it("refuses a retirement by an agent", async () => {
    const res = await call(`/v1/atoms/${retiredId}/retire`, agentKey, {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(await statusOf(retiredId)).toBe("canonical");
  });

  /**
   * The behaviour that actually matters, and the reason this is asserted
   * against retrieval rather than against the status column.
   *
   * `retired` is a status, but what a reviewer bought by retiring the atom is
   * that no agent is told about it again. A route that wrote the status and
   * left the atom in the candidate pool would pass a status assertion and fail
   * the customer, so the test drives `search` — before and after, same query —
   * and the only thing that changed between the two calls is the retirement.
   *
   * Lexical mode on purpose: it needs no embedder, so this stays runnable in CI
   * with no network and no secrets.
   */
  it("takes a retired atom out of everything that serves canonical knowledge", async () => {
    const find = async (): Promise<string[]> => {
      const res = await call(
        `/v1/projects/${decide.projectId}/search`,
        humanKey,
        {
          method: "POST",
          body: JSON.stringify({
            query: "errors reported on-call engineer",
            mode: "lexical",
            limit: 100,
          }),
        },
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: { atomId: string }[] }).items.map(
        (hit) => hit.atomId,
      );
    };

    // It has to be there first, or the assertion after it proves nothing.
    expect(await find()).toContain(retiredId);

    const res = await call(`/v1/atoms/${retiredId}/retire`, humanKey, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("retired");

    expect(await find()).not.toContain(retiredId);
  });

  /**
   * One decision, both halves. `supersedes` is a field on ratify rather than a
   * fifth route precisely so that the ledger cannot record the promotion
   * without the withdrawal.
   */
  it("promotes the successor and withdraws the incumbent in one call", async () => {
    const ratifyIncumbent = await call(
      `/v1/atoms/${incumbentId}/ratify`,
      humanKey,
      { method: "POST" },
    );
    expect(ratifyIncumbent.status).toBe(200);

    const res = await call(
      `/v1/atoms/${successorId}/ratify?supersedes=${incumbentId}`,
      humanKey,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("canonical");

    const incumbent = (await (
      await call(`/v1/atoms/${incumbentId}`, humanKey)
    ).json()) as { status: string; supersededBy: string | null };
    expect(incumbent.status).toBe("superseded");
    // Which atom replaced it, not merely that one did. A withdrawal that does
    // not name its successor is a hole in the record the reviewer is answering
    // for later.
    expect(incumbent.supersededBy).toBe(successorId);

    // Exactly one of the pair is canonical. Two would be the state the whole
    // deduplication pass exists to prevent: the same claim, twice, both binding.
    const statuses = [await statusOf(successorId), incumbent.status];
    expect(statuses.filter((status) => status === "canonical")).toHaveLength(1);
  });

  /**
   * The atomicity test, and the most important one here.
   *
   * The candidate's promotion and the incumbent's withdrawal share a
   * transaction, so a refusal has to roll the promotion back rather than commit
   * half of it. Both statuses are asserted afterwards, because a route that
   * answered 409 while leaving the candidate canonical would look correct from
   * the status code alone and would have created exactly the duplicate the
   * field exists to avoid.
   */
  it("moves neither atom when the atom being superseded is provisional", async () => {
    const res = await call(
      `/v1/atoms/${blockedCandidateId}/ratify?supersedes=${neverCanonicalId}`,
      humanKey,
      { method: "POST" },
    );
    expect(res.status).toBe(409);

    expect(await statusOf(blockedCandidateId)).toBe("provisional");
    expect(await statusOf(neverCanonicalId)).toBe("provisional");
  });

  /**
   * `superseded_by` is org-scoped by a foreign key and no further, so nothing
   * underneath stops one project's atom being withdrawn by another's — and a
   * supersede across that line removes knowledge from a project whose reviewer
   * never saw the request. Same org, different project, which is the case a
   * tenancy check would let through.
   */
  it("refuses to supersede an atom in another project", async () => {
    const res = await call(
      `/v1/atoms/${strayCandidateId}/ratify?supersedes=${queueCanonicalId}`,
      humanKey,
      { method: "POST" },
    );
    expect(res.status).toBe(409);

    expect(await statusOf(strayCandidateId)).toBe("provisional");
    expect(await statusOf(queueCanonicalId)).toBe("canonical");
  });

  /**
   * The read-only provenance the export rides on: who ratified an atom, and
   * which atom replaced it. Asserted through the list because that is the
   * only route that joins the ratifying actor's display name in.
   */
  it("lists ratifier provenance and succession alongside each atom", async () => {
    const res = await call(`/v1/projects/${decide.projectId}/atoms`, humanKey);
    expect(res.status).toBe(200);

    const page = (await res.json()) as {
      items: {
        id: string;
        supersededBy: string | null;
        ratifiedByKind: string | null;
        ratifiedByName: string | null;
      }[];
    };
    const byId = new Map(page.items.map((item) => [item.id, item]));

    // Ratified by the fixture's human, and named so the export can say so.
    const successor = byId.get(successorId);
    expect(successor?.ratifiedByKind).toBe("human");
    expect(successor?.ratifiedByName).toBe("human");
    expect(successor?.supersededBy).toBeNull();

    // The withdrawn incumbent names what replaced it.
    expect(byId.get(incumbentId)?.supersededBy).toBe(successorId);

    // A row nobody has decided carries null across all three fields.
    const untouched = byId.get(untouchedId);
    expect(untouched?.supersededBy).toBeNull();
    expect(untouched?.ratifiedByKind).toBeNull();
    expect(untouched?.ratifiedByName).toBeNull();
  });

  /**
   * What the reviewer is handed, in the order they have to work it.
   *
   * The section body arrives **whole**: the decision rests on reading the quote
   * inside its surrounding section, and a reviewer who has to fetch that
   * separately is a reviewer who stops checking it. A page limit may shorten
   * the list of items and must never shorten this string.
   */
  it("serves the provisional atoms oldest first, with their provenance entire", async () => {
    const res = await call(`/v1/projects/${queue.projectId}/queue`, humanKey);
    expect(res.status).toBe(200);

    const page = (await res.json()) as {
      items: {
        id: string;
        status: string;
        sectionBody: string;
        sourceSpan: { start: number; end: number };
      }[];
      total: number;
    };

    // FIFO, and the canonical atom in this project is absent — the queue is the
    // undecided work, not everything the project knows.
    expect(page.items.map((item) => item.id)).toEqual(queueIds);
    expect(page.total).toBe(queueIds.length);
    expect(page.items.map((item) => item.status)).toEqual([
      "provisional",
      "provisional",
      "provisional",
    ]);

    for (const item of page.items) {
      expect(item.sectionBody).toBe(BODY);
    }

    // `{ start, end }` and never the `"[7,19)"` Postgres stores, which no
    // client should have to learn to parse.
    const first = BODY.indexOf("Logs are retained for thirty days.");
    expect(page.items[0]?.sourceSpan).toEqual({
      start: first,
      end: first + "Logs are retained for thirty days.".length,
    });
  });

  it("pages without changing what it is counting", async () => {
    const at = async (offset: number) =>
      (await (
        await call(
          `/v1/projects/${queue.projectId}/queue?limit=1&offset=${offset}`,
          humanKey,
        )
      ).json()) as { items: { id: string }[]; total: number };

    const head = await at(0);
    const next = await at(1);

    expect(head.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(head.items[0]?.id).not.toBe(next.items[0]?.id);
    // `total` counts what matched, not what came back, so it is the same number
    // on both pages. A caller that had to add up pages to learn the size would
    // get a different answer on every request.
    expect(head.total).toBe(next.total);
    expect(head.total).toBe(queueIds.length);
  });

  /**
   * Filtering narrows the list, and `total` narrows with it — which is exactly
   * why the backlog figure is served from `/ratification` and not from here.
   * `docs/15-ratification.md`: a reviewer who filters to `convention` must not
   * be shown a healthy queue while the `constraint` backlog ages behind it, and
   * a count sitting next to a filtered list is a count somebody will read as
   * the queue's.
   */
  it("filters by kind, and says so in the total", async () => {
    const res = await call(
      `/v1/projects/${queue.projectId}/queue?kind=decision`,
      humanKey,
    );
    expect(res.status).toBe(200);

    const page = (await res.json()) as {
      items: { id: string; kind: string }[];
      total: number;
    };
    expect(page.items.map((item) => item.kind)).toEqual(["decision"]);
    expect(page.total).toBe(1);
    // Narrower than the queue itself, so this number cannot be the backlog.
    expect(page.total).toBeLessThan(queueIds.length);
  });

  /**
   * Reading-order item 6 (`docs/15-ratification.md`): the incumbent rides the
   * queue item, computed at read time, and only when a canonical atom's
   * similarity falls in the judge band `[0.80, 0.93)`. Embeddings are written
   * through the superuser because the fixture's atoms were proposed over the
   * API, which — correctly — accepts no vectors.
   */
  it("serves the canonical near neighbour in the judge band, and only then", async () => {
    // Unit vectors with a chosen angle, so the similarity is exact: the
    // candidate is e1, the canonical atom cos·e1 + sin·e2.
    const unit = (cos: number) => {
      const v = new Array(1024).fill(0);
      v[0] = cos;
      v[1] = Math.sqrt(1 - cos * cos);
      return `[${v.join(",")}]`;
    };
    const fetchIncumbents = async () => {
      const res = await call(`/v1/projects/${queue.projectId}/queue`, humanKey);
      expect(res.status).toBe(200);
      const page = (await res.json()) as {
        items: {
          id: string;
          incumbent: {
            id: string;
            statement: string;
            similarity: number;
          } | null;
        }[];
      };
      return new Map(page.items.map((item) => [item.id, item.incumbent]));
    };

    const db = await admin();
    try {
      await db.query("update atoms set embedding = $1 where id = $2", [
        unit(1),
        queueIds[0],
      ]);
      // 0.85 sits inside the band, so the incumbent is on screen.
      await db.query("update atoms set embedding = $1 where id = $2", [
        unit(0.85),
        queueCanonicalId,
      ]);

      const inBand = await fetchIncumbents();
      const shown = inBand.get(queueIds[0] ?? "");
      expect(shown?.id).toBe(queueCanonicalId);
      expect(shown?.statement).toBe("Metrics are sampled once a second.");
      expect(shown?.similarity).toBeCloseTo(0.85, 6);
      // No embedding on the candidate: no near neighbour, nothing to show,
      // and the reviewer is not asked to go looking.
      expect(inBand.get(queueIds[1] ?? "")).toBeNull();

      // At 0.95 the dedup pass would have suppressed the candidate — above
      // the band nothing is served. Below it the atoms are just distinct.
      for (const outside of [0.95, 0.5]) {
        await db.query("update atoms set embedding = $1 where id = $2", [
          unit(outside),
          queueCanonicalId,
        ]);
        expect((await fetchIncumbents()).get(queueIds[0] ?? "")).toBeNull();
      }
    } finally {
      await db.query(
        "update atoms set embedding = null where id = any($1::uuid[])",
        [[queueIds[0], queueCanonicalId]],
      );
      await db.end();
    }
  });

  // 200 with nothing, not 404: RLS answers "no rows" for the same reason the
  // egress list does, and the project id is not the caller's to confirm.
  it("never shows another org's atoms", async () => {
    const res = await call(`/v1/projects/${orgBProjectId}/queue`, humanKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [],
      total: 0,
      returned: 0,
      truncated: false,
    });
  });

  /**
   * The age is required, and the missing default is the feature.
   *
   * `docs/14-roadmap.md` leaves this metric's bar unchosen and
   * `docs/02-principles.md` (10) forbids inventing one. A default here would
   * become that bar by accident — nobody would have chosen it, and everybody
   * would report against it.
   */
  it("refuses to guess what 'old' means", async () => {
    const res = await call(
      `/v1/projects/${quietProjectId}/ratification`,
      humanKey,
    );
    expect(res.status).toBe(400);
  });

  // Parsed from a string rather than coerced, so a typo fails at the boundary
  // instead of arriving as `NaN` and being compared against silently.
  it("refuses an age that is not a number", async () => {
    const res = await call(
      `/v1/projects/${quietProjectId}/ratification?olderThanSeconds=abc`,
      humanKey,
    );
    expect(res.status).toBe(400);
  });

  /**
   * Nothing decided, so no median. Zero would be a lie — it would read as
   * "decided instantly" on a dashboard, which is the one answer a project with
   * an untouched queue must never give.
   */
  it("reports no median when nothing has been decided", async () => {
    const res = await call(
      `/v1/projects/${quietProjectId}/ratification?olderThanSeconds=60`,
      humanKey,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      decided: number;
      medianSecondsToDecision: number | null;
      backlog: number;
      backlogShareOlderThan: number | null;
    };
    expect(body.decided).toBe(0);
    expect(body.medianSecondsToDecision).toBeNull();
    expect(body.backlog).toBe(0);
    // 0/0 is not 0, for the same reason.
    expect(body.backlogShareOlderThan).toBeNull();
  });

  /**
   * The regression test for a 500 that only appeared with work in the queue.
   *
   * `queueStats` declared `oldestProposedAt` as `sql<Date | null>` — a type
   * assertion, not a conversion. The node-postgres driver hands `timestamptz`
   * back as a raw string unless a column's own `mapFromDriverValue` builds the
   * Date, and a bare `sql` expression never gets one. So `.toISOString()` threw,
   * and it threw *only* when the backlog was non-empty, because the optional
   * chain short-circuited on the `null` an empty project returns.
   *
   * The empty-project test above passed throughout. That is precisely why this
   * one exists: the happy path it was checking was the one path that could not
   * fail.
   */
  it("reports the backlog on a project that actually has one", async () => {
    const res = await call(
      `/v1/projects/${queue.projectId}/ratification?olderThanSeconds=1`,
      humanKey,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      backlog: number;
      oldestProposedAt: string | null;
      queueAgeSeconds: number | null;
      backlogShareOlderThan: number | null;
    };

    expect(body.backlog).toBeGreaterThan(0);
    // A real timestamp, serialised, rather than a Date that never was one.
    expect(body.oldestProposedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(body.oldestProposedAt ?? ""))).toBe(false);
    expect(body.queueAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.backlogShareOlderThan).toBeGreaterThanOrEqual(0);
  });

  /**
   * The rule that makes a separate route worth having.
   *
   * `docs/15-ratification.md`: backlog and queue age describe the work
   * outstanding, not the slice somebody happens to be looking at. A reviewer who
   * filters to one document must not see the backlog shrink — that would turn a
   * view into a report and quietly tell them the queue is healthier than it is.
   *
   * `queueStats` takes no filter argument at all, which is the only shape a
   * caller cannot get wrong; this asserts the consequence end to end.
   */
  it("does not let a filtered view change the backlog it reports", async () => {
    const unfiltered = (await (
      await call(
        `/v1/projects/${queue.projectId}/ratification?olderThanSeconds=1`,
        humanKey,
      )
    ).json()) as { backlog: number };

    const filteredQueue = (await (
      await call(
        `/v1/projects/${queue.projectId}/queue?kind=constraint`,
        humanKey,
      )
    ).json()) as { total: number };

    const afterFiltering = (await (
      await call(
        `/v1/projects/${queue.projectId}/ratification?olderThanSeconds=1`,
        humanKey,
      )
    ).json()) as { backlog: number };

    expect(afterFiltering.backlog).toBe(unfiltered.backlog);
    // And the filter really did narrow something, or the test proves nothing.
    expect(filteredQueue.total).toBeLessThan(unfiltered.backlog);
  });
});
