import type { AtomEvent, AtomRejectReason } from "@standfast/core";
import { and, desc, eq, getTableColumns, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import { atomEvents, atoms } from "../schema/knowledge.js";
import { actors } from "../schema/tenancy.js";

export type Atom = typeof atoms.$inferSelect;

/** An atom as the list serves it: the row, plus the ratifier's display name. */
export type AtomListItem = Atom & {
  readonly ratifiedByName: string | null;
};

export async function listAtoms(
  db: Db,
  projectId: string,
  page: Page,
): Promise<Paged<AtomListItem>> {
  const rows = await db
    .select({
      ...getTableColumns(atoms),
      ratifiedByName: actors.displayName,
      pageTotal: PAGE_TOTAL,
    })
    .from(atoms)
    // LEFT, mirroring the proposer join in `listQueue`: the ratifier is
    // provenance and not a filter, and null is the honest answer for a row
    // nobody has ratified.
    .leftJoin(actors, eq(actors.id, atoms.ratifiedBy))
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
    retired: 0,
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
 *
 * `supersedes` is a field here rather than a fifth route because
 * `docs/15-ratification.md` treats replacing an atom as one decision, not two
 * that happen to be adjacent. Both rows move and both ledger entries are
 * written under the transaction `withActor` already opened, so the failure of
 * either takes the other with it; a supersede that committed halfway would
 * leave the project holding two canonical atoms that contradict each other,
 * with retrieval free to serve whichever it ranked higher.
 */
export async function ratifyAtom(
  db: Db,
  orgId: string,
  actorId: string,
  atomId: string,
  supersedes?: string,
): Promise<Atom | undefined> {
  const rows = await db
    .update(atoms)
    .set({
      status: "canonical",
      ratifiedBy: actorId,
      ratifiedByKind: "human",
      // The database's clock, not this process's. Every other timestamp in the
      // schema defaults to `now()`, so a `new Date()` here was the one value
      // that could not be soundly ordered against the rest — and phase 3 orders
      // against exactly this column, to ask whether an atom has been checked
      // since it was last ratified. The API and Postgres are different machines
      // in any real deployment, and tens of milliseconds of NTP skew is
      // ordinary; it was enough to make a finding recorded *after* a
      // ratification look as though it came before.
      ratifiedAt: sql`now()`,
    })
    .where(and(eq(atoms.id, atomId), eq(atoms.status, "provisional")))
    .returning();

  const atom = rows[0];
  if (!atom) {
    return undefined;
  }

  if (supersedes !== undefined) {
    const incumbent = await db
      .update(atoms)
      .set({ status: "superseded", supersededBy: atom.id })
      .where(
        and(
          eq(atoms.id, supersedes),
          // Only a canonical atom has anything to lose, and only a different
          // one: after the update above the candidate is itself canonical, so
          // without this it would match its own id and be recorded as its own
          // predecessor.
          ne(atoms.id, atomId),
          eq(atoms.status, "canonical"),
          // Same project as the candidate. `superseded_by` is org-scoped by a
          // foreign key and no further, so nothing underneath stops one
          // project's atom being retired by another's — and a supersede across
          // that line silently removes knowledge from a project whose reviewer
          // never saw the request.
          eq(atoms.projectId, atom.projectId),
        ),
      )
      .returning({ id: atoms.id });

    // Throws rather than returning undefined, and that asymmetry is the whole
    // point. `withActor` has a transaction open around this, so the throw is
    // what rolls the candidate's promotion back; returning would commit a
    // half-applied supersede and leave two canonical atoms making contradictory
    // claims — the state the deduplication pass exists to prevent.
    if (!incumbent[0]) {
      throw new Error(
        `atom ${supersedes} is not a canonical atom in the same project`,
      );
    }
  }

  await db.insert(atomEvents).values({
    orgId,
    atomId: atom.id,
    event: "ratified",
    actorId,
  });

  if (supersedes !== undefined) {
    // The same human, on both halves of one decision. `docs/15-ratification.md`
    // makes superseding a field on ratify rather than a fifth route precisely so
    // that the ledger cannot record the promotion without the withdrawal.
    await db.insert(atomEvents).values({
      orgId,
      atomId: supersedes,
      event: "superseded",
      actorId,
    });
  }

  return atom;
}

/**
 * The human-only guard that `rejectAtom` and `retireAtom` share.
 *
 * `ratifyAtom` and `resolveFinding` get this from the schema for free: both
 * write a `*_by_kind` column, and the composite foreign key to
 * `actors (id, kind)` means an agent's id cannot be stored beside the literal
 * `'human'`. Neither transition below writes such a column — a rejection is not
 * a ratification, and `atom_events` keys its actor by `(actor_id, org_id)`
 * alone — so as the schema stands **no constraint can refuse an agent here**.
 * Closing that honestly needs a migration: an `actor_kind` column on
 * `atom_events`, the composite key to `actors (id, kind)`, and a check binding
 * `rejected` and `retired` to `human`. Until it exists this is a rule in
 * application code, which `docs/04-data-model.md` calls a convention with
 * better marketing, and it is not upgraded by being written well.
 *
 * So it is put where application code is hardest to forget: inside the UPDATE's
 * own WHERE, as a correlated EXISTS the database evaluates in the same
 * statement that moves the row. That buys the two properties a preceding
 * `getActorKind` call cannot — no window between the test and the write, and no
 * ordering for a caller to get wrong. It does not buy the guarantee.
 *
 * RLS scopes the subquery to the tenant, so an actor id borrowed from another
 * org is invisible to it rather than merely the wrong kind.
 */
function actorIsHuman(actorId: string): SQL {
  return sql`exists (select 1 from ${actors}
             where ${actors.id} = ${actorId} and ${actors.kind} = 'human')`;
}

/**
 * One terminal decision: guard the transition, move the row, write the ledger.
 *
 * Shared by reject and retire because the ledger entry is the part a caller
 * must not be able to skip. `atom_events` is append-only by grant — the row
 * cannot be added afterwards by a repair script — so a status written without
 * its event is a decision that never happened as far as the throughput metric
 * in `docs/12-evaluation.md` can tell.
 */
async function decideTerminally(
  db: Db,
  orgId: string,
  actorId: string,
  atomId: string,
  from: Atom["status"],
  to: Atom["status"],
  event: AtomEvent,
  reason: AtomRejectReason | null = null,
  reasonNote: string | null = null,
): Promise<Atom | undefined> {
  const rows = await db
    .update(atoms)
    .set({ status: to })
    .where(
      and(eq(atoms.id, atomId), eq(atoms.status, from), actorIsHuman(actorId)),
    )
    .returning();

  const atom = rows[0];
  if (!atom) {
    // Zero rows means the wrong status or a non-human actor, and the route owes
    // the client 409 for one and 403 for the other. Asking which costs a read
    // only on the path that has already failed. The throw matches what an agent
    // reaching `ratifyAtom` gets today — a constraint violation, not a quiet
    // no-op — so a caller that forgets its own check fails loudly either way.
    if ((await getActorKind(db, actorId)) !== "human") {
      throw new Error(`only a human may move an atom to '${to}'`);
    }
    return undefined;
  }

  await db.insert(atomEvents).values({
    orgId,
    atomId: atom.id,
    event,
    actorId,
    reason,
    reasonNote,
  });

  return atom;
}

/**
 * A human declines a proposal. Terminal.
 *
 * Terminal because re-extraction matches against existing rows
 * (`docs/05-extraction.md`), so a rejection that returned the atom to the queue
 * would re-propose itself every run and the queue could never be drained.
 *
 * `ratified_by` and `ratified_at` stay null on purpose. They are not a generic
 * "who decided" pair — `countDrift` reads `ratified_at` to ask which canonical
 * atoms have gone unchecked since they were last ratified, and stamping it here
 * would put rejected atoms into a queue that only holds canonical ones.
 *
 * The reason is optional at every layer, per `docs/15-ratification.md`: a
 * required field turns a decision into a form, and a reviewer made to justify a
 * rejection ratifies marginal atoms instead. `atom_events_reason_only_on_reject`
 * and `atom_events_reason_note_shape` are what keep the free text bounded and
 * confined to this one event.
 */
export async function rejectAtom(
  db: Db,
  orgId: string,
  actorId: string,
  atomId: string,
  reason: AtomRejectReason | null = null,
  reasonNote: string | null = null,
): Promise<Atom | undefined> {
  return decideTerminally(
    db,
    orgId,
    actorId,
    atomId,
    "provisional",
    "rejected",
    "rejected",
    reason,
    reasonNote,
  );
}

/**
 * A human withdraws a canonical atom that has no successor. Terminal.
 *
 * Distinct from `rejectAtom` because `rejected` has a job: it means a human
 * looked at a proposal and said no, which is the signal extraction precision is
 * measured with. An atom the project has abandoned was right when it was
 * ratified and the world moved on; counting it as an extraction failure would
 * make the corpus lie. Distinct from `superseded` because there is no successor
 * — `superseded` carries `superseded_by`, and a withdrawal has nothing to put
 * in it.
 *
 * Takes no reason. The closed vocabulary is a rejection vocabulary and the
 * schema says so, `atom_events_reason_only_on_reject` refusing a reason on any
 * other event; *not true* and *not a decision* are not why a project retires
 * something it once agreed with.
 */
export async function retireAtom(
  db: Db,
  orgId: string,
  actorId: string,
  atomId: string,
): Promise<Atom | undefined> {
  return decideTerminally(
    db,
    orgId,
    actorId,
    atomId,
    "canonical",
    "retired",
    "retired",
  );
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
