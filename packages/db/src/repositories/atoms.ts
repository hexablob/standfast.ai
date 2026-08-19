import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { atomEvents, atoms } from "../schema/knowledge.js";
import { actors } from "../schema/tenancy.js";

export type Atom = typeof atoms.$inferSelect;

export async function listAtoms(
  db: Db,
  projectId: string,
  page: Page,
): Promise<Paged<Atom>> {
  const rows = await db
    .select({ ...getTableColumns(atoms), pageTotal: PAGE_TOTAL })
    .from(atoms)
    .where(eq(atoms.projectId, projectId))
    // Two atoms extracted from one section share a `created_at` to the
    // microsecond often enough that this matters.
    .orderBy(desc(atoms.createdAt), atoms.id)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

/**
 * How many atoms a project holds, by status.
 *
 * Counted in the database rather than by listing atoms and tallying them in
 * the caller. `docs/03-architecture.md` calls the MCP server's local
 * `STATUS_SCAN_LIMIT` a cap in the wrong layer, and it was worse than a
 * layering smell: `status` fetched every atom to produce four numbers, and
 * above the cap the numbers it produced were counts of an arbitrary prefix.
 * A project past the limit under-reported the ratification queue — the one
 * figure `docs/02-principles.md` (5) calls a first-class product metric.
 *
 * Four numbers, one round trip, exact at any size.
 */
export async function countAtomsByStatus(
  db: Db,
  projectId: string,
): Promise<Record<Atom["status"], number>> {
  const rows = await db
    .select({ status: atoms.status, count: sql<number>`count(*)::int` })
    .from(atoms)
    .where(eq(atoms.projectId, projectId))
    .groupBy(atoms.status);

  // Every status present, including the ones with no rows: an absent key and a
  // zero read differently to a caller, and only one of them is true.
  const counts: Record<Atom["status"], number> = {
    provisional: 0,
    canonical: 0,
    rejected: 0,
    superseded: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export async function getAtom(
  db: Db,
  atomId: string,
): Promise<Atom | undefined> {
  const rows = await db
    .select()
    .from(atoms)
    .where(eq(atoms.id, atomId))
    .limit(1);
  return rows[0];
}

/**
 * Status is not a parameter.
 *
 * Everything an agent writes is born provisional (invariant 2), so there is
 * no argument for the caller to win here — the column simply takes its
 * default. The database would refuse a canonical atom with no ratifier
 * anyway; this is about not offering the door.
 */
export async function createAtom(
  db: Db,
  orgId: string,
  actorId: string,
  input: {
    projectId: string;
    documentId: string;
    sectionId: string;
    statement: string;
    kind: "decision" | "convention" | "constraint";
    sourceQuote: string;
    sourceSpan: { start: number; end: number };

    // Which extractor produced this, or absent when none did. Not a status
    // parameter and not an extraction-only path: the worker calls this exact
    // function, with the same rules, and only records where the statement came
    // from. `propose` and the atoms endpoint leave it null, which is what stops
    // re-projection reporting hand-written knowledge as extractor-abandoned.
    extractorVersion?: string | null;
  },
): Promise<Atom> {
  const rows = await db
    .insert(atoms)
    .values({
      orgId,
      projectId: input.projectId,
      documentId: input.documentId,
      sectionId: input.sectionId,
      statement: input.statement,
      kind: input.kind,
      sourceQuote: input.sourceQuote,
      sourceSpan: `[${input.sourceSpan.start},${input.sourceSpan.end})`,
      extractorVersion: input.extractorVersion ?? null,
    })
    .returning();

  const atom = rows[0];
  if (!atom) {
    throw new Error("insert returned no row");
  }

  await db.insert(atomEvents).values({
    orgId,
    atomId: atom.id,
    event: "proposed",
    actorId,
  });

  return atom;
}

export async function getActorKind(
  db: Db,
  actorId: string,
): Promise<"human" | "agent" | undefined> {
  const rows = await db
    .select({ kind: actors.kind })
    .from(actors)
    .where(eq(actors.id, actorId))
    .limit(1);
  return rows[0]?.kind;
}

/**
 * Promotes a provisional atom to canonical.
 *
 * The composite foreign key on `(ratified_by, ratified_by_kind)` is what
 * actually stops an agent doing this; the caller is expected to have checked
 * the actor's kind first so the client gets 403 and a sentence rather than a
 * constraint-violation error. Both layers stay — the check is the message,
 * the constraint is the guarantee.
 */
export async function ratifyAtom(
  db: Db,
  orgId: string,
  actorId: string,
  atomId: string,
): Promise<Atom | undefined> {
  const rows = await db
    .update(atoms)
    .set({
      status: "canonical",
      ratifiedBy: actorId,
      ratifiedByKind: "human",
      ratifiedAt: new Date(),
    })
    .where(and(eq(atoms.id, atomId), eq(atoms.status, "provisional")))
    .returning();

  const atom = rows[0];
  if (!atom) {
    return undefined;
  }

  await db.insert(atomEvents).values({
    orgId,
    atomId: atom.id,
    event: "ratified",
    actorId,
  });

  return atom;
}

/**
 * Attaches an embedding to an atom.
 *
 * Separate from `createAtom` rather than a parameter on it, for the reason the
 * column's own comment gives: an atom exists the moment it is extracted and is
 * embedded a step later. Adding a parameter only the worker ever passes is the
 * drift that "there is no extraction-specific write path" exists to prevent.
 *
 * Costs no re-verification. Migration 0002's UPDATE trigger has a WHEN clause
 * that excludes `embedding`, which was written in anticipation of this.
 */
export async function setAtomEmbedding(
  db: Db,
  atomId: string,
  embedding: readonly number[],
): Promise<void> {
  await db
    .update(atoms)
    .set({ embedding: [...embedding] })
    .where(eq(atoms.id, atomId));
}
