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
