import {
  contentHash,
  locateQuote,
  type Section,
  sectionMarkdown,
} from "@standfast/core";
import { asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import type { ExtractionEnqueue } from "../extraction.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { atoms, documentSections, documents } from "../schema/knowledge.js";
import { requireExtractorActor } from "./actors.js";

export type Document = typeof documents.$inferSelect;
export type DocumentSection = typeof documentSections.$inferSelect;

export async function listDocuments(
  db: Db,
  projectId: string,
  page: Page,
): Promise<Paged<Document>> {
  const rows = await db
    .select({ ...getTableColumns(documents), pageTotal: PAGE_TOTAL })
    .from(documents)
    .where(eq(documents.projectId, projectId))
    // `path` is unique per project, so it is already a total order.
    .orderBy(documents.path)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

export async function getDocument(
  db: Db,
  documentId: string,
): Promise<Document | undefined> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return rows[0];
}

export async function getSection(
  db: Db,
  sectionId: string,
): Promise<DocumentSection | undefined> {
  const rows = await db
    .select()
    .from(documentSections)
    .where(eq(documentSections.id, sectionId))
    .limit(1);
  return rows[0];
}

export async function listSections(
  db: Db,
  documentId: string,
  page: Page,
): Promise<Paged<DocumentSection>> {
  const rows = await db
    .select({ ...getTableColumns(documentSections), pageTotal: PAGE_TOTAL })
    .from(documentSections)
    .where(eq(documentSections.documentId, documentId))
    // `(document_id, ordinal)` is unique, so ordinal is a total order here.
    .orderBy(documentSections.ordinal)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

/**
 * What one write did to a document's sections, as four sets of section ids.
 *
 * `inserted` and `updated` together are the extraction work list: an inserted
 * section is new to the system, an updated one kept its row — and so its
 * atoms — while its text moved on. `deleted` is what the write destroyed, and
 * the atoms that cited those sections went with them. `matched` cost nothing
 * and is the number that should be large.
 */
export type SectionChange = {
  matched: string[];
  inserted: string[];
  updated: string[];
  deleted: string[];
};

export type PutDocumentResult = {
  document: Document;
  sections: SectionChange;

  /**
   * The sections a `section.extract` job was sent for.
   *
   * Equal to `sections.inserted` plus `sections.updated` today. Named
   * separately because the enqueue rule and the diff are two different facts
   * that happen to coincide: when the repair sweep for orphaned suppressions
   * arrives it will enqueue sections that were neither, and the diff fields
   * must keep meaning what they say.
   */
  enqueued: string[];

  /**
   * Atoms whose section was rewritten in place and whose `source_quote` no
   * longer appears in the new body.
   *
   * The atom itself is untouched: deciding that a decision no longer holds is
   * a ratification-shaped act, and no status means "the prose changed
   * underneath it" — that vocabulary is phase 1's to add, not this path's to
   * improvise. Recorded, never acted on, and dropped by the HTTP route; this
   * is a surface for ratification tooling, not for the wire.
   */
  staleCitations: string[];
};

/**
 * Creates or replaces a document and re-derives its sections.
 *
 * Sections are computed from the body, never supplied by the caller. They are
 * a projection of the document in the same sense that atoms are a projection
 * of sections, and an API that accepted them would let a client assert a
 * provenance the content does not support.
 *
 * The whole write runs inside the caller's transaction, so a document is never
 * visible with a mixture of old and new sections.
 */
export async function putDocument(
  db: Db,
  orgId: string,
  projectId: string,
  input: { path: string; title?: string | null; body: string },
  // Required, never defaulted. A default would let a caller enqueue without
  // meaning to, and would leave nothing to substitute in the test that watches
  // a rolled-back push leave no job behind.
  extraction: ExtractionEnqueue,
): Promise<PutDocumentResult> {
  const hash = contentHash(input.body);

  const rows = await db
    .insert(documents)
    .values({
      orgId,
      projectId,
      path: input.path,
      title: input.title ?? null,
      body: input.body,
      contentHash: hash,
    })
    .onConflictDoUpdate({
      target: [documents.orgId, documents.projectId, documents.path],
      set: {
        title: input.title ?? null,
        body: input.body,
        contentHash: hash,
        updatedAt: new Date(),
      },
    })
    .returning();

  const document = rows[0];
  if (!document) {
    throw new Error("upsert returned no row");
  }

  const { sections, staleCitations } = await reconcileSections(
    db,
    orgId,
    document.id,
    input.body,
  );

  // The enqueue is here rather than in the route, and that is the point of
  // taking the port as an argument. The HTTP endpoint is not the only writer:
  // the MCP server, the CLI and the eventual sync daemon all arrive through
  // this function, and each would otherwise have to remember. A boundary you
  // can cross by forgetting something is not a boundary.
  //
  // Inside the caller's transaction, which is what makes exit criterion 2 a
  // property of the write path rather than a behaviour the worker has to
  // notice: reconcileSections already knows exactly which hashes moved, so an
  // unchanged document produces an empty list and sends nothing.
  const enqueued: string[] = [];
  // Updated sections re-extract at their new text. Re-extraction can propose
  // statements the section's surviving atoms already carry; the dedup pass —
  // threshold, judge, suppressions — is the mitigation, not this enqueue.
  const extractable = [...sections.inserted, ...sections.updated];
  if (extractable.length > 0) {
    // Resolved here, not carried in from the route. docs/05-extraction.md
    // declines the pushing human's actor for this payload: it attributes a
    // model's output to a person, which is the one attribution error this
    // system cannot afford.
    const actorId = await requireExtractorActor(db, orgId);

    // Counted down, so section 0 outranks section 1. Without it every job in
    // this transaction shares a created_on and pg-boss breaks the tie on a
    // uuid — which makes first-writer-wins dedup a coin flip between two
    // sections of the same document.
    const total = extractable.length;
    for (const [index, sectionId] of extractable.entries()) {
      await extraction.enqueue(
        db,
        {
          orgId,
          actorId,
          projectId,
          sectionId,
          extractorVersion: extraction.extractorVersion,
        },
        total - index,
      );
      enqueued.push(sectionId);
    }
  }

  return { document, sections, enqueued, staleCitations };
}

/**
 * Matches the sections the body now yields against the rows already stored,
 * and touches only the difference.
 *
 * This used to delete every section and re-insert the set. `atoms.section_id`
 * cascades on delete, so pushing a byte-identical document destroyed every atom
 * derived from it — human-ratified knowledge erased in response to a write an
 * agent could trigger, which is the inverse of the second founding invariant.
 *
 * The match is a multiset, not a lookup. `section_hash` covers the heading path
 * and the text and deliberately not the ordinal, so two sections of one
 * document can legitimately share a hash — a repeated heading with the same
 * content under it. Consuming from a bucket in ordinal order pairs them
 * one-to-one and keeps the pairing stable.
 */
async function reconcileSections(
  db: Db,
  orgId: string,
  documentId: string,
  body: string,
): Promise<{ sections: SectionChange; staleCitations: string[] }> {
  const existing = await db
    .select()
    .from(documentSections)
    .where(eq(documentSections.documentId, documentId))
    .orderBy(asc(documentSections.ordinal));

  const next = sectionMarkdown(body);

  const available = new Map<string, DocumentSection[]>();
  for (const row of existing) {
    const bucket = available.get(row.sectionHash);
    if (bucket) {
      bucket.push(row);
    } else {
      available.set(row.sectionHash, [row]);
    }
  }

  const matched: string[] = [];
  const claimed = new Set<string>();
  const renumber: { id: string; ordinal: number }[] = [];
  const residual: Section[] = [];

  for (const section of next) {
    const row = available.get(section.sectionHash)?.shift();
    if (!row) {
      residual.push(section);
      continue;
    }
    claimed.add(row.id);
    matched.push(row.id);
    if (row.ordinal !== section.ordinal) {
      renumber.push({ id: row.id, ordinal: section.ordinal });
    }
  }

  // Pass 2 — section identity for the text that moved on. An edited section
  // has a new hash, so pass 1 cannot see it, and deleting its row would
  // cascade to its atoms — a whitespace fix erasing ratified knowledge. The
  // fallback key is `(ordinal, heading_path)`, exact on both parts, and unique
  // by construction on either side because `(document_id, ordinal)` is unique
  // — so this is a lookup, not a multiset. A section that was edited *and*
  // moved misses the key and falls through to delete-and-insert by design: a
  // looser rule could marry the wrong rows, and a wrong identity is worse
  // than a lost one.
  const identity = new Map<string, DocumentSection>();
  for (const row of existing) {
    if (!claimed.has(row.id)) {
      identity.set(JSON.stringify([row.ordinal, row.headingPath]), row);
    }
  }

  const rewrite: { id: string; section: Section }[] = [];
  const create: Section[] = [];
  for (const section of residual) {
    const row = identity.get(
      JSON.stringify([section.ordinal, section.headingPath]),
    );
    if (!row) {
      create.push(section);
      continue;
    }
    claimed.add(row.id);
    rewrite.push({ id: row.id, section });
  }

  const deleted = existing
    .filter((row) => !claimed.has(row.id))
    .map((row) => row.id);

  if (deleted.length > 0) {
    await db
      .delete(documentSections)
      .where(inArray(documentSections.id, deleted));
  }

  if (renumber.length > 0 || rewrite.length > 0) {
    // Deferred for this transaction only, and only when something actually
    // moves. A section going from ordinal 4 to ordinal 2 collides with the row
    // still sitting at 2, and no ordering of the updates avoids it in general —
    // a rotation has no safe first move. The constraint is DEFERRABLE INITIALLY
    // IMMEDIATE, so this is the one writer that gets the slack, and it is still
    // checked before commit. Rewrites take the slack too: their ordinal writes
    // are no-ops today, but an update that touches the column gets the same
    // treatment rather than an ordering assumption.
    await db.execute(
      sql`set constraints "document_sections_document_ordinal_key" deferred`,
    );
  }

  for (const move of renumber) {
    await db
      .update(documentSections)
      .set({ ordinal: move.ordinal })
      .where(eq(documentSections.id, move.id));
  }

  for (const { id, section } of rewrite) {
    await db
      .update(documentSections)
      .set({
        body: section.body,
        sectionHash: section.sectionHash,
        ordinal: section.ordinal,
      })
      .where(eq(documentSections.id, id));
  }

  let inserted: string[] = [];
  if (create.length > 0) {
    const created = await db
      .insert(documentSections)
      .values(
        create.map((section) => ({
          orgId,
          documentId,
          ordinal: section.ordinal,
          headingPath: section.headingPath,
          body: section.body,
          sectionHash: section.sectionHash,
        })),
      )
      .returning({ id: documentSections.id });
    inserted = created.map((row) => row.id);
  }

  // Re-anchoring, deliberately *after* the body rewrites: the 0002 BEFORE
  // UPDATE trigger verifies a span against the section body as stored, so the
  // body must already be the new one when a span moves. `locateQuote` counts
  // Unicode code points — the units every span was written in — and takes the
  // first occurrence, which is its existing contract.
  const staleCitations: string[] = [];
  for (const { id, section } of rewrite) {
    const cited = await db
      .select({
        id: atoms.id,
        sourceQuote: atoms.sourceQuote,
        sourceSpan: atoms.sourceSpan,
      })
      .from(atoms)
      .where(eq(atoms.sectionId, id));

    for (const atom of cited) {
      const span = locateQuote(section.body, atom.sourceQuote);
      if (!span) {
        // The quote is gone. The atom is neither deleted nor demoted — only a
        // human decides that a decision no longer holds — merely reported.
        staleCitations.push(atom.id);
        continue;
      }
      const range = `[${span.start},${span.end})`;
      if (range !== atom.sourceSpan) {
        await db
          .update(atoms)
          .set({ sourceSpan: range })
          .where(eq(atoms.id, atom.id));
      }
    }
  }

  return {
    sections: { matched, inserted, updated: rewrite.map((r) => r.id), deleted },
    staleCitations,
  };
}

export async function deleteDocument(
  db: Db,
  documentId: string,
): Promise<boolean> {
  const rows = await db
    .delete(documents)
    .where(eq(documents.id, documentId))
    .returning({ id: documents.id });
  return rows.length > 0;
}

/** One row of the sync manifest: enough to diff against, nothing to read. */
export type DocumentManifestEntry = {
  id: string;
  path: string;
  contentHash: string;
};

/**
 * The manifest `standfast sync` diffs against: `(id, path, content_hash)` per
 * document and nothing else. The narrow SELECT is the guarantee — the body is
 * never read off the table, so no layer above this one has to remember to
 * strip it.
 */
export async function listDocumentManifest(
  db: Db,
  projectId: string,
  page: Page,
): Promise<Paged<DocumentManifestEntry>> {
  const rows = await db
    .select({
      id: documents.id,
      path: documents.path,
      contentHash: documents.contentHash,
      pageTotal: PAGE_TOTAL,
    })
    .from(documents)
    .where(eq(documents.projectId, projectId))
    // `path` is unique per project, so it is already a total order.
    .orderBy(documents.path)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}
