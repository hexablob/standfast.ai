import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, withActor } from "../client.js";
import type { ExtractionEnqueue } from "../extraction.js";
import { pageOf } from "../pagination.js";
import type { SectionExtractJob } from "../queue.js";
import {
  ensureExtractorActor,
  requireExtractorActor,
} from "../repositories/actors.js";
import { createAtom, getAtom, ratifyAtom } from "../repositories/atoms.js";
import {
  listSections,
  putDocument,
  type SectionChange,
} from "../repositories/documents.js";
import { claimExtraction } from "../repositories/extractions.js";
import {
  adminClient,
  adminUrl,
  ensureTestRole,
  type Seed,
  seed,
} from "./harness.js";

/**
 * Phase 1a — the invariants that hold without a model.
 *
 * Two defects shipped in phase 0 and are closed here: an atom could name
 * document A and a section of document B, and a byte-identical push deleted
 * every section and so cascaded away every atom derived from the document.
 * The second one destroyed human-ratified knowledge in response to a write an
 * agent could trigger, which is the inverse of the second founding invariant.
 *
 * Everything runs through `withActor` against the unprivileged role, the way
 * production reaches the database. As the superuser these would pass while
 * proving nothing about the row-level-security half.
 */

/**
 * Two sections, each ending in a blank line.
 *
 * The trailing blank is load-bearing. A section's hash covers its text, and
 * the text depends on where the blank lines fall — without one after the last
 * section, swapping the two would change both bodies and there would be
 * nothing left to match.
 */
const TWO_SECTIONS =
  "# Alpha\nShip on Fridays.\n\n# Beta\nNever revert main.\n\n";
const SWAPPED = "# Beta\nNever revert main.\n\n# Alpha\nShip on Fridays.\n\n";

const QUOTE = "Ship on Fridays.";

let data: Seed;
let orgBDocument = "";
let orgBSection = "";
const originalUrl = process.env["DATABASE_URL"];

beforeAll(async () => {
  await ensureTestRole();
  data = await seed();

  // A section in org B, so "cannot read it" has a real target rather than a
  // uuid that happens not to exist.
  const admin = await adminClient();
  try {
    const document = await admin.query<{ id: string }>(
      "select id from documents where org_id = $1 limit 1",
      [data.orgB],
    );
    orgBDocument = document.rows[0]?.id ?? "";
    const section = await admin.query<{ id: string }>(
      `insert into document_sections
         (org_id, document_id, ordinal, heading_path, body, section_hash)
       values ($1, $2, 0, ARRAY['B'], '# B secret', 'sec-b') returning id`,
      [data.orgB, orgBDocument],
    );
    orgBSection = section.rows[0]?.id ?? "";
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl());
  url.username = "standfast_test";
  url.password = "standfast_test";
  process.env["DATABASE_URL"] = url.toString();
});

afterAll(async () => {
  await closePool();
  if (originalUrl) {
    process.env["DATABASE_URL"] = originalUrl;
  }
});

/** The version these tests enqueue at. Opaque, and only its stability matters. */
const EV = "ev1-testtesttest01";

/**
 * An enqueue that records instead of sending.
 *
 * Substituted for the real one so the assertions here are about what
 * `putDocument` decided to enqueue, not about whether pg-boss stored it. The
 * commit's other test file does the pg-boss half.
 */
function recorder(): {
  extraction: ExtractionEnqueue;
  calls: SectionExtractJob[];
} {
  const calls: SectionExtractJob[] = [];
  return {
    extraction: {
      extractorVersion: EV,
      enqueue: async (_db, job) => {
        calls.push(job);
      },
    },
    calls,
  };
}

const recorded = recorder();

async function push(
  path: string,
  body: string,
): Promise<{
  documentId: string;
  sections: SectionChange;
  enqueued: string[];
  staleCitations: string[];
}> {
  return withActor(data.orgA, data.humanA, async (db) => {
    const result = await putDocument(
      db,
      data.orgA,
      data.projectA,
      { path, body },
      recorded.extraction,
    );
    return {
      documentId: result.document.id,
      sections: result.sections,
      enqueued: result.enqueued,
      staleCitations: result.staleCitations,
    };
  });
}

const sectionsOf = (documentId: string) =>
  withActor(data.orgA, data.humanA, (db) =>
    listSections(db, documentId, pageOf()).then((page) => page.items),
  );

/**
 * Runs a write that must be refused and returns what the database said.
 *
 * Drizzle wraps a driver error in one whose message is the SQL it sent and
 * hangs the database's own message off `cause`. Matching the wrapper would
 * pass for any failure at all — including a typo in the fixture — so these
 * assertions have to reach the cause.
 */
async function refusal(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("expected the write to be refused, and it was not");
}

/**
 * Creates an atom whose span is read off the stored section body rather than
 * counted by hand — the trigger compares the two, so a hand-counted offset
 * would fail as loudly as a broken invariant and mean nothing.
 */
async function atomOn(
  documentId: string,
  sectionId: string,
  quote: string,
): Promise<string> {
  return withActor(data.orgA, data.humanA, async (db) => {
    const { items: sections } = await listSections(db, documentId, pageOf());
    const body = sections.find((s) => s.id === sectionId)?.body ?? "";
    const start = body.indexOf(quote);
    const atom = await createAtom(db, data.orgA, data.humanA, {
      projectId: data.projectA,
      documentId,
      sectionId,
      statement: quote,
      kind: "convention",
      sourceQuote: quote,
      sourceSpan: { start, end: start + quote.length },
    });
    return atom.id;
  });
}

describe("a byte-identical push is not a rewrite", () => {
  it("matches every section and produces no new work", async () => {
    const first = await push("docs/stable.md", TWO_SECTIONS);
    expect(first.sections.inserted).toHaveLength(2);

    const alpha = (await sectionsOf(first.documentId))[0];
    const atomId = await atomOn(first.documentId, alpha?.id ?? "", QUOTE);

    const again = await push("docs/stable.md", TWO_SECTIONS);

    // `inserted` is the extraction work list, and empty is the whole point:
    // nothing here is new, so phase 1c will have nothing to enqueue.
    expect(again.documentId).toBe(first.documentId);
    expect(again.sections.inserted).toEqual([]);
    expect(again.sections.updated).toEqual([]);
    expect(again.sections.deleted).toEqual([]);
    expect(again.sections.matched).toHaveLength(2);
    expect(again.staleCitations).toEqual([]);

    const survived = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(survived?.id).toBe(atomId);
  });

  it("moves a reordered section instead of replacing it", async () => {
    const first = await push("docs/swap.md", TWO_SECTIONS);
    const alphaId = (await sectionsOf(first.documentId))[0]?.id ?? "";
    const atomId = await atomOn(first.documentId, alphaId, QUOTE);

    const again = await push("docs/swap.md", SWAPPED);
    expect(again.sections.inserted).toEqual([]);
    expect(again.sections.deleted).toEqual([]);

    // Same row, new ordinal — which is only possible because the ordinal key
    // is a deferrable constraint. A delete-and-reinsert would have minted a
    // new id and taken the atom with it.
    const after = await sectionsOf(first.documentId);
    expect(after[0]?.headingPath).toEqual(["Beta"]);
    expect(after[1]?.id).toBe(alphaId);

    const survived = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(survived?.id).toBe(atomId);
  });

  it("deletes only the sections the new body no longer yields", async () => {
    const first = await push("docs/shrink.md", TWO_SECTIONS);
    const before = await sectionsOf(first.documentId);

    const again = await push("docs/shrink.md", "# Alpha\nShip on Fridays.\n\n");
    expect(again.sections.matched).toEqual([before[0]?.id]);
    expect(again.sections.deleted).toEqual([before[1]?.id]);
    expect(again.sections.inserted).toEqual([]);
  });
});

describe("an edited section keeps its identity", () => {
  it("keeps the row and its atoms when only the text changed", async () => {
    const first = await push("docs/edit.md", TWO_SECTIONS);
    const beta = (await sectionsOf(first.documentId))[1];
    const atomId = await atomOn(
      first.documentId,
      beta?.id ?? "",
      "Never revert main.",
    );

    const again = await push(
      "docs/edit.md",
      "# Alpha\nShip on Fridays.\n\n# Beta\nNever revert main. Ever.\n\n",
    );

    // Pass 2: same ordinal, same heading path, new hash. The row survives,
    // it is re-enqueued for extraction, and its atom is untouched.
    expect(again.sections.updated).toEqual([beta?.id]);
    expect(again.sections.inserted).toEqual([]);
    expect(again.sections.deleted).toEqual([]);
    expect(again.enqueued).toEqual([beta?.id]);
    expect(again.staleCitations).toEqual([]);

    const survived = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(survived?.id).toBe(atomId);
  });

  it("carries a ratified atom across a whitespace fix", async () => {
    const first = await push("docs/ratified.md", TWO_SECTIONS);
    const alpha = (await sectionsOf(first.documentId))[0];
    const atomId = await atomOn(first.documentId, alpha?.id ?? "", QUOTE);
    await withActor(data.orgA, data.humanA, (db) =>
      ratifyAtom(db, data.orgA, data.humanA, atomId),
    );

    // The regression this mechanism exists for: before pass 2, a trailing
    // space deleted the section row and the cascade took the ratification
    // with it.
    const again = await push(
      "docs/ratified.md",
      "# Alpha\nShip on Fridays. \n\n# Beta\nNever revert main.\n\n",
    );
    expect(again.sections.updated).toEqual([alpha?.id]);
    expect(again.staleCitations).toEqual([]);

    const survived = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(survived?.status).toBe("canonical");
  });

  it("moves the span with the quote", async () => {
    const first = await push(
      "docs/moved-quote.md",
      "# Rule\nShip on Fridays.\n\n",
    );
    const section = (await sectionsOf(first.documentId))[0];
    const atomId = await atomOn(first.documentId, section?.id ?? "", QUOTE);

    const again = await push(
      "docs/moved-quote.md",
      "# Rule\nAlways and forever: Ship on Fridays.\n\n",
    );
    expect(again.sections.updated).toEqual([section?.id]);
    expect(again.staleCitations).toEqual([]);

    // Re-anchored to the quote's first occurrence in the new body, in code
    // points — ASCII here, so indexOf agrees with the stored form.
    const body = (await sectionsOf(first.documentId))[0]?.body ?? "";
    const start = body.indexOf(QUOTE);
    expect(start).toBeGreaterThan(7);
    const row = await withActor(data.orgA, data.humanA, (db) =>
      db.execute<{ span: string }>(
        sql`select source_span as span from atoms where id = ${atomId}::uuid`,
      ),
    );
    expect(row.rows[0]?.span).toBe(`[${start},${start + QUOTE.length})`);
  });

  it("reports a vanished quote and touches nothing", async () => {
    const first = await push(
      "docs/vanished-quote.md",
      "# Rule\nShip on Fridays.\n\n",
    );
    const section = (await sectionsOf(first.documentId))[0];
    const atomId = await atomOn(first.documentId, section?.id ?? "", QUOTE);

    const again = await push(
      "docs/vanished-quote.md",
      "# Rule\nShip on Mondays.\n\n",
    );

    // Recorded, never acted on. The id is reported and the atom is exactly
    // as it was — status, quote and span included: no status means "the
    // prose changed underneath it", and none is invented here.
    expect(again.sections.updated).toEqual([section?.id]);
    expect(again.staleCitations).toEqual([atomId]);

    const atom = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(atom?.status).toBe("provisional");
    expect(atom?.sourceQuote).toBe(QUOTE);
  });

  it("still deletes a section that was edited and moved", async () => {
    const first = await push("docs/edited-moved.md", TWO_SECTIONS);
    const betaId = (await sectionsOf(first.documentId))[1]?.id ?? "";
    const atomId = await atomOn(first.documentId, betaId, "Never revert main.");

    // Beta's text and its (ordinal, heading_path) key both changed, so
    // neither pass can claim it. Pinned on purpose: the strict rule prefers
    // losing an identity to marrying the wrong rows.
    const again = await push(
      "docs/edited-moved.md",
      "# Beta\nAlways revert main.\n\n# Alpha\nShip on Fridays.\n\n",
    );
    expect(again.sections.deleted).toEqual([betaId]);
    expect(again.sections.updated).toEqual([]);
    expect(again.sections.inserted).toHaveLength(1);

    const gone = await withActor(data.orgA, data.humanA, (db) =>
      getAtom(db, atomId),
    );
    expect(gone).toBeUndefined();
  });
});

describe("an atom cites one section of one document", () => {
  it("refuses a section that belongs to a different document", async () => {
    const a = await push("docs/one.md", "# One\nalpha\n");
    const b = await push("docs/two.md", "# Two\nbeta\n");
    const beta = (await sectionsOf(b.documentId))[0];

    // The trigger reaches the pairing first, because a BEFORE ROW trigger runs
    // ahead of referential integrity. The composite key behind it is the
    // guarantee — asserted directly below, since nothing can make it speak
    // first.
    const said = await refusal(() =>
      withActor(data.orgA, data.humanA, (db) =>
        createAtom(db, data.orgA, data.humanA, {
          projectId: data.projectA,
          documentId: a.documentId,
          sectionId: beta?.id ?? "",
          statement: "beta",
          kind: "decision",
          sourceQuote: "beta",
          sourceSpan: { start: 6, end: 10 },
        }),
      ),
    );
    expect(said).toMatch(/is not a readable section of document/);
  });

  it("carries the composite key as a constraint, not a convention", async () => {
    const definition = await withActor(data.orgA, data.humanA, async (db) => {
      const r = await db.execute<{ definition: string }>(
        sql`select pg_get_constraintdef(oid) as definition
            from pg_constraint
            where conname = 'atoms_document_section_fk'
              and conrelid = 'public.atoms'::regclass`,
      );
      return r.rows[0]?.definition;
    });

    expect(definition).toMatch(/FOREIGN KEY \(document_id, section_id\)/);
    expect(definition).toMatch(
      /REFERENCES document_sections\(document_id, id\)/,
    );
  });

  // Referential integrity checks bypass row-level security, so the foreign key
  // would accept this. The trigger is SECURITY INVOKER precisely so that an
  // actor cannot cite another tenant's section and learn from the outcome
  // whether its guess at the quote was right.
  it("refuses a section belonging to another tenant", async () => {
    const said = await refusal(() =>
      withActor(data.orgA, data.humanA, (db) =>
        createAtom(db, data.orgA, data.humanA, {
          projectId: data.projectA,
          documentId: orgBDocument,
          sectionId: orgBSection,
          statement: "secret",
          kind: "decision",
          sourceQuote: "# B secret",
          sourceSpan: { start: 0, end: 10 },
        }),
      ),
    );
    expect(said).toMatch(/is not a readable section of document/);
  });
});

describe("a quote is the text its span names", () => {
  it("refuses a quote the span does not contain", async () => {
    const doc = await push("docs/quote.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    const start = section?.body.indexOf(QUOTE) ?? 0;

    const said = await refusal(() =>
      withActor(data.orgA, data.humanA, (db) =>
        createAtom(db, data.orgA, data.humanA, {
          projectId: data.projectA,
          documentId: doc.documentId,
          sectionId: section?.id ?? "",
          statement: "Ship on Mondays.",
          kind: "convention",
          // The right length in the right place, and still not the text there.
          sourceQuote: "Ship on Mondays.",
          sourceSpan: { start, end: start + QUOTE.length },
        }),
      ),
    );
    expect(said).toMatch(/source_quote does not match span/);
  });

  it("refuses a span that runs past the end of the section", async () => {
    const doc = await push("docs/short.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    const start = section?.body.indexOf(QUOTE) ?? 0;

    const said = await refusal(() =>
      withActor(data.orgA, data.humanA, (db) =>
        createAtom(db, data.orgA, data.humanA, {
          projectId: data.projectA,
          documentId: doc.documentId,
          sectionId: section?.id ?? "",
          statement: QUOTE,
          kind: "convention",
          sourceQuote: QUOTE,
          sourceSpan: { start, end: start + QUOTE.length + 50 },
        }),
      ),
    );
    expect(said).toMatch(/source_quote does not match span/);
  });
});

describe("extraction bookkeeping records what cannot be recomputed", () => {
  /** Claims a section at a version, returning the row id. */
  async function claim(
    sectionId: string,
    version: string,
    columns = "",
    values = "",
  ): Promise<string> {
    return withActor(data.orgA, data.humanA, async (db) => {
      const rows = await db.execute<{ id: string }>(
        sql`insert into section_extractions
              (org_id, section_id, project_id, extractor_version, section_hash${sql.raw(columns)})
            values (${data.orgA}::uuid, ${sectionId}::uuid, ${data.projectA}::uuid,
                    ${version}, 'hash'${sql.raw(values)})
            returning id`,
      );
      return rows.rows[0]?.id ?? "";
    });
  }

  it("refuses a second claim on the same section at the same version", async () => {
    const doc = await push("docs/claim.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    await claim(section?.id ?? "", "ev1-aaaa");

    // This is the whole of exit criterion 2 as a database property: a redelivered
    // job, or a second worker racing the first, cannot extract twice.
    const said = await refusal(() => claim(section?.id ?? "", "ev1-aaaa"));
    expect(said).toMatch(/section_extractions_section_version_key/);
  });

  it("lets the same section be claimed again at a new version", async () => {
    const doc = await push("docs/reproject.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    await claim(section?.id ?? "", "ev1-aaaa");

    // Re-projection is the point of keying on the version rather than the
    // section: a better extractor gets to look again.
    const second = await claim(section?.id ?? "", "ev2-bbbb");
    expect(second).not.toBe("");
  });

  it("reclaims a succeeded run when the section hash has moved", async () => {
    const doc = await push("docs/rehash.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    await claim(
      section?.id ?? "",
      "ev1-rehash",
      `, status, finished_at, attempts`,
      `, 'succeeded', now(), 1`,
    );

    const at = (sectionHash: string) =>
      withActor(data.orgA, data.humanA, (db) =>
        claimExtraction(db, {
          orgId: data.orgA,
          projectId: data.projectA,
          sectionId: section?.id ?? "",
          sectionHash,
          extractorVersion: "ev1-rehash",
          leaseSeconds: 60,
        }),
      );

    // Same hash: finished work is finished, a redelivered job stays free.
    expect(await at("hash")).toEqual({ kind: "already-succeeded" });

    // The section was edited in place — same row, new hash. Without the hash
    // comparison this would be "already-succeeded" and the re-enqueued
    // extraction would be skipped forever: silent staleness instead of work.
    expect(await at("hash-moved")).toMatchObject({
      kind: "claimed",
      attempts: 2,
    });
  });

  it("refuses a lease on a run that has already finished", async () => {
    const doc = await push("docs/lease.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];

    const said = await refusal(() =>
      claim(
        section?.id ?? "",
        "ev1-lease",
        `, status, finished_at, lease_expires_at`,
        `, 'succeeded', now(), now() + interval '15 minutes'`,
      ),
    );
    expect(said).toMatch(/section_extractions_lease_iff_running/);
  });

  it("refuses a drop count larger than the candidates seen", async () => {
    const doc = await push("docs/counts.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];

    const said = await refusal(() =>
      claim(
        section?.id ?? "",
        "ev1-counts",
        `, candidates_total, candidates_dropped`,
        `, 2, 3`,
      ),
    );
    expect(said).toMatch(/section_extractions_candidates_coherent/);
  });

  it("refuses one candidate count without the other", async () => {
    const doc = await push("docs/half.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];

    const said = await refusal(() =>
      claim(section?.id ?? "", "ev1-half", `, candidates_total`, `, 4`),
    );
    expect(said).toMatch(/section_extractions_candidates_coherent/);
  });

  it("attributes an atom nobody extracted to no extractor", async () => {
    const doc = await push("docs/byhand.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    const atomId = await atomOn(doc.documentId, section?.id ?? "", QUOTE);

    // `propose` and the atoms endpoint both land here. The null is what stops
    // re-projection reporting hand-written knowledge as extractor-abandoned.
    const rows = await withActor(data.orgA, data.humanA, (db) =>
      db.execute<{ extractor_version: string | null }>(
        sql`select extractor_version from atoms where id = ${atomId}::uuid`,
      ),
    );
    expect(rows.rows[0]?.extractor_version).toBeNull();
  });
});

describe("the extractor is an actor that cannot ratify", () => {
  it("resolves by system key, not by display name", async () => {
    const resolved = await withActor(data.orgA, data.humanA, (db) =>
      requireExtractorActor(db, data.orgA),
    );
    expect(resolved).toBe(data.extractorA);

    // Renaming it changes nothing. That is the whole reason the column exists:
    // display_name is editable and this handle is not.
    await withActor(data.orgA, data.humanA, (db) =>
      db.execute(
        sql`update actors set display_name = 'renamed' where id = ${data.extractorA}::uuid`,
      ),
    );
    const again = await withActor(data.orgA, data.humanA, (db) =>
      requireExtractorActor(db, data.orgA),
    );
    expect(again).toBe(data.extractorA);
  });

  it("is idempotent, so a second org creation does not mint a twin", async () => {
    const first = await withActor(data.orgA, data.humanA, (db) =>
      ensureExtractorActor(db, data.orgA),
    );
    const second = await withActor(data.orgA, data.humanA, (db) =>
      ensureExtractorActor(db, data.orgA),
    );
    expect(first).toBe(data.extractorA);
    expect(second).toBe(data.extractorA);
  });

  it("cannot be recorded as the human who ratified an atom", async () => {
    const doc = await push("docs/ratify.md", "# Rule\nShip on Fridays.\n\n");
    const section = (await sectionsOf(doc.documentId))[0];
    const atomId = await atomOn(doc.documentId, section?.id ?? "", QUOTE);

    // The extractor inherits this rather than being granted an exception to it:
    // `actors` is unique on (id, kind) and `atoms` references (id, 'human'), so
    // an actor created as an agent has no row to point at.
    const said = await refusal(() =>
      withActor(data.orgA, data.humanA, (db) =>
        db.execute(
          sql`update atoms
                 set status = 'canonical',
                     ratified_by = ${data.extractorA}::uuid,
                     ratified_by_kind = 'human',
                     ratified_at = now()
               where id = ${atomId}::uuid`,
        ),
      ),
    );
    expect(said).toMatch(/atoms_ratified_by_actors_id_kind_fk|foreign key/i);
  });

  it("does not leak across tenants", async () => {
    // orgB has its own extractor. Resolving inside orgA's actor context must
    // not find it, and must not find nothing-because-RLS-hid-orgA's either.
    const inA = await withActor(data.orgA, data.humanA, (db) =>
      requireExtractorActor(db, data.orgA),
    );
    expect(inA).toBe(data.extractorA);
    expect(inA).not.toBe(data.extractorB);

    await expect(
      withActor(data.orgA, data.humanA, (db) =>
        requireExtractorActor(db, data.orgB),
      ),
    ).rejects.toThrow(/no extractor actor/);
  });
});

describe("the write path decides what extraction sees", () => {
  it("enqueues once per new section, and not once per push", async () => {
    const before = recorded.calls.length;
    const first = await push("docs/enqueue.md", TWO_SECTIONS);

    const sent = recorded.calls.slice(before);
    expect(first.enqueued).toHaveLength(2);
    expect(sent.map((j) => j.sectionId).sort()).toEqual(
      [...first.sections.inserted].sort(),
    );
  });

  it("enqueues nothing for a byte-identical push", async () => {
    await push("docs/idempotent.md", TWO_SECTIONS);

    // Exit criterion 2, as a property of the write path rather than something
    // the worker has to notice. reconcileSections already knows which hashes
    // moved; an unchanged document yields an empty list and sends nothing.
    const before = recorded.calls.length;
    const again = await push("docs/idempotent.md", TWO_SECTIONS);

    expect(again.enqueued).toEqual([]);
    expect(recorded.calls.length).toBe(before);
  });

  it("enqueues exactly the section that changed", async () => {
    await push("docs/partial.md", TWO_SECTIONS);

    const before = recorded.calls.length;
    const edited = await push(
      "docs/partial.md",
      "# Alpha\nShip on Fridays.\n\n# Beta\nAlways revert main.\n\n",
    );

    // "Zero on unchanged" alone is satisfied by an enqueue that never fires.
    // This is the half that says the mechanism works.
    const sent = recorded.calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(edited.enqueued).toHaveLength(1);
    // The edited section kept its row: the job names the *updated* id, and
    // nothing was inserted or destroyed on the way.
    expect(sent[0]?.sectionId).toBe(edited.sections.updated[0]);
    expect(edited.sections.inserted).toEqual([]);
    expect(edited.sections.deleted).toEqual([]);
  });

  it("attributes the job to the extractor, never to the pusher", async () => {
    const before = recorded.calls.length;
    await push("docs/attribution.md", TWO_SECTIONS);
    const sent = recorded.calls.slice(before);

    for (const job of sent) {
      // docs/05-extraction.md declines the pushing human's actor: it attributes
      // a model's output to a person, which is the one attribution error this
      // system cannot afford.
      expect(job.actorId).toBe(data.extractorA);
      expect(job.actorId).not.toBe(data.humanA);
      expect(job.orgId).toBe(data.orgA);
      expect(job.projectId).toBe(data.projectA);
      expect(job.extractorVersion).toBe(EV);
    }
  });

  it("enqueues nothing when a push deletes sections and adds none", async () => {
    await push("docs/shrink.md", TWO_SECTIONS);

    const before = recorded.calls.length;
    const shrunk = await push(
      "docs/shrink.md",
      "# Alpha\nShip on Fridays.\n\n",
    );

    expect(shrunk.sections.deleted).toHaveLength(1);
    expect(shrunk.enqueued).toEqual([]);
    expect(recorded.calls.length).toBe(before);
  });
});
