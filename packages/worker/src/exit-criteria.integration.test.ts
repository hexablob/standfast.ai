import {
  createProject,
  currentExtractorVersion,
  enqueueSectionExtract,
  putDocument,
  stopBoss,
  withActor,
} from "@standfast/db";
import {
  adminClient,
  adminUrl,
  ensureTestRole,
  installQueue,
  type Seed,
  seed,
} from "@standfast/db/testing";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drain } from "./drain.js";
import { fakePorts } from "./fakes.js";
import { makeSectionExtractHandler } from "./handler.js";
import { rebuildProject } from "./rebuild.js";

/**
 * Phase 1's exit criteria, as tests.
 *
 * docs/14-roadmap.md numbers them 1 to 4. Criterion 4 is a measurement and
 * belongs to the harness in eval/; the three that are gates live here.
 */

const EV = currentExtractorVersion();
const NEVER_ABORTED = new AbortController().signal;
const extraction = { enqueue: enqueueSectionExtract, extractorVersion: EV };

/**
 * Chosen to exercise the things that break quietly.
 *
 * A section whose hash repeats inside one document (the multiset match in
 * reconcileSections), an emoji before a quote (code-point spans), a section
 * with no bullets at all (zero candidates), and two documents stating the same
 * thing (dedup, and therefore ordering).
 */
const DOCS: ReadonlyArray<{ path: string; body: string }> = [
  {
    path: "docs/a-conventions.md",
    body: [
      "# Conventions",
      "",
      "- Deploys happen on Fridays",
      "- Tabs indent Makefiles",
      "",
      "# Repeated",
      "",
      "- Shared bullet text",
      "",
      "# Repeated",
      "",
      "- Shared bullet text",
      "",
    ].join("\n"),
  },
  {
    path: "docs/b-unicode.md",
    body: [
      "# Shipping 🚢",
      "",
      "- Releases 🚀 are cut from main only",
      "",
    ].join("\n"),
  },
  {
    path: "docs/c-prose.md",
    body: ["# Prose", "", "This section states nothing in a bullet.", ""].join(
      "\n",
    ),
  },
  {
    path: "docs/d-duplicate.md",
    body: ["# Elsewhere", "", "- Deploys happen on Fridays", ""].join("\n"),
  },
];

let data: Seed;
let admin: Client;
let projectId: string;
let originalUrl: string | undefined;

beforeAll(async () => {
  await ensureTestRole();
  await installQueue(adminUrl());
  data = await seed();
  admin = await adminClient();

  originalUrl = process.env["DATABASE_URL"];
  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();

  const project = await withActor(data.orgA, data.humanA, (db) =>
    createProject(db, data.orgA, {
      name: "exit-criteria",
      slug: `exit-criteria-${process.pid}`,
    }),
  );
  projectId = project.id;

  for (const doc of DOCS) {
    await withActor(data.orgA, data.humanA, (db) =>
      putDocument(db, data.orgA, projectId, doc, extraction),
    );
  }
  await drainAll();
}, 90_000);

afterAll(async () => {
  await stopBoss();
  await admin?.end();
  if (originalUrl) process.env["DATABASE_URL"] = originalUrl;
});

async function drainAll() {
  return drain(makeSectionExtractHandler({ ports: fakePorts() }));
}

/** Everything about the project's atoms that a rebuild must reproduce. */
async function snapshot() {
  const r = await admin.query(
    `select d.path, s.ordinal, a.statement, a.kind, a.source_quote,
            lower(a.source_span) as span_start, upper(a.source_span) as span_end,
            a.status, a.extractor_version
       from atoms a
       join document_sections s on s.id = a.section_id
       join documents d on d.id = a.document_id
      where a.project_id = $1
      order by d.path, s.ordinal, lower(a.source_span), a.statement`,
    [projectId],
  );
  return r.rows;
}

describe("criterion 1 — every stored quote verifies", () => {
  it("returns zero atoms whose quote is not the text its span names", async () => {
    // Run as the admin, deliberately: RLS would scope this to one org and the
    // criterion is over the whole database. Zero, not low — there is no
    // acceptable rate of atoms citing text that is not there.
    const r = await admin.query(
      `select a.id
         from atoms a
         join document_sections s on s.id = a.section_id
        where substring(s.body
                        from lower(a.source_span) + 1
                        for  upper(a.source_span) - lower(a.source_span))
              is distinct from a.source_quote`,
    );
    expect(r.rows).toEqual([]);
  });

  it("stored a span that a non-ASCII section makes non-trivial", async () => {
    // The emoji document. If the worker had recorded UTF-16 indices the query
    // above would already have failed — this asserts the case was actually
    // present rather than silently absent from the fixture.
    const r = await admin.query<{ source_quote: string; span_start: number }>(
      `select a.source_quote, lower(a.source_span) as span_start
         from atoms a join documents d on d.id = a.document_id
        where d.project_id = $1 and d.path = $2`,
      [projectId, "docs/b-unicode.md"],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.source_quote).toContain("🚀");
  });
});

describe("criterion 2 — an unchanged project enqueues nothing", () => {
  it("enqueues zero jobs when every document is pushed again unchanged", async () => {
    const before = await queuedJobs();

    for (const doc of DOCS) {
      await withActor(data.orgA, data.humanA, (db) =>
        putDocument(db, data.orgA, projectId, doc, extraction),
      );
    }

    expect(await queuedJobs()).toBe(before);
  });

  it("enqueues nothing on a re-run even when the queue is drained again", async () => {
    const result = await drainAll();
    expect(result.handled).toBe(0);
  });
});

async function queuedJobs(): Promise<number> {
  // Scoped to this project. The queue has one name for every tenant in it, so
  // an unscoped count answers a question about the whole database — which is
  // never the question a criterion-2 assertion is asking.
  const r = await admin.query<{ n: string }>(
    `select count(*)::text n from pgboss.job
      where name = 'section.extract' and data->>'projectId' = $1`,
    [projectId],
  );
  return Number(r.rows[0]?.n ?? "0");
}

describe("criterion 3 — the corpus rebuilds from the documents alone", () => {
  /** Clears everything a rebuild must be able to re-derive. */
  async function clearDerived() {
    await admin.query("delete from atoms where project_id = $1", [projectId]);
    await admin.query("delete from atom_suppressions where project_id = $1", [
      projectId,
    ]);
    // The half the roadmap's wording leaves out, and without which this test is
    // a tautology: section_extractions is what makes a re-run a no-op, so
    // clearing only atoms would re-enqueue jobs that each find their section
    // already succeeded, write nothing, and compare equal because nothing ran.
    await admin.query(
      `delete from section_extractions
        where section_id in (select s.id from document_sections s
                             join documents d on d.id = s.document_id
                            where d.project_id = $1)`,
      [projectId],
    );
  }

  async function rebuild() {
    const handle = makeSectionExtractHandler({ ports: fakePorts() });
    return withActor(data.orgA, data.humanA, (db) =>
      rebuildProject(db, data.orgA, projectId, EV, (job) =>
        handle(job, NEVER_ABORTED),
      ),
    );
  }

  it("re-derives the same knowledge the queue produced", async () => {
    const queued = await snapshot();
    expect(queued.length).toBeGreaterThan(0);

    // The criterion runs on a project with no ratified atoms.
    // docs/05-extraction.md: ratification does not re-derive, and a literal
    // delete-and-rebuild over ratified knowledge destroys the record of every
    // human decision ever made about it.
    const ratified = await admin.query(
      "select id from atoms where project_id = $1 and status <> 'provisional'",
      [projectId],
    );
    expect(ratified.rows).toEqual([]);

    await clearDerived();
    expect(await snapshot()).toEqual([]);

    const sections = await rebuild();
    expect(sections.length).toBeGreaterThan(0);

    // Statements, not rows. The fixture contains two byte-identical sections,
    // so which of them ends up holding the atom is a first-writer-wins race
    // when the queue schedules them and fixed when a rebuild walks them in
    // order — docs/05-extraction.md calls both outcomes equally correct. What
    // may not change is the knowledge itself.
    const statements = (rows: Array<Record<string, unknown>>) =>
      rows
        .map((r) => `${r["kind"]}|${r["statement"]}|${r["source_quote"]}`)
        .sort();

    expect(statements(await snapshot())).toEqual(statements(queued));
  }, 60_000);

  it("re-derives byte-identically twice, provenance included", async () => {
    await clearDerived();
    await rebuild();
    const first = await snapshot();

    await clearDerived();
    await rebuild();

    // Two rebuilds, compared in full — every span, kind, status and the section
    // each atom cites. This is the assertion the fixed processing order exists
    // for, and it is why a rebuild is sequential rather than fanned out across
    // however many workers happen to be running.
    expect(await snapshot()).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  }, 60_000);

  it("processes in the order the extractor version fixes", async () => {
    const seen: string[] = [];
    await withActor(data.orgA, data.humanA, (db) =>
      rebuildProject(db, data.orgA, projectId, EV, async (job) => {
        seen.push(job.sectionId);
      }),
    );

    const expected = await admin.query<{ id: string }>(
      `select s.id from document_sections s
         join documents d on d.id = s.document_id
        where d.project_id = $1
        order by d.path asc, s.ordinal asc`,
      [projectId],
    );

    // Dedup is first-writer-wins, so the order is part of the extractor version
    // rather than an implementation detail. A different order would produce a
    // different and equally correct corpus, which a harness reads as noise.
    expect(seen).toEqual(expected.rows.map((r) => r.id));
  });
});
