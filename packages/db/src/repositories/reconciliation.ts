import {
  type FindingVerdict,
  type ReconciliationTrigger,
  statusForVerdict,
} from "@standfast/core";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  notExists,
  sql,
} from "drizzle-orm";
import type { Db } from "../client.js";
import { PAGE_TOTAL, type Page, type Paged, paged } from "../pagination.js";
import {
  atoms,
  reconciliationFindings,
  reconciliationRuns,
} from "../schema/knowledge.js";

export type Finding = typeof reconciliationFindings.$inferSelect;

/**
 * One verdict on one atom against one file, as it arrives from the agent.
 *
 * Note what is not here, and cannot be added without a reviewer seeing it in
 * `wire-allowlist.ts`: no snippet, no diff, no excerpt, no content hash. A
 * finding is a verdict and a pointer.
 */
export type ReconcileItem = {
  atomId: string;
  verdict: FindingVerdict;
  filePath: string;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
  rationale?: string | undefined;
};

/**
 * Records one submission of verdicts: one run row, then every finding.
 *
 * **One call, one run, N findings — never one write per finding.** A per-finding
 * write makes a partially-submitted run representable, and a run that lost half
 * its `honored` verdicts on the way in has a broken denominator. The
 * false-positive rate is the metric that decides whether this whole phase
 * ships, so the shape that can silently corrupt it is the shape not offered.
 *
 * No `db.transaction` here: the caller already holds one. Every request path
 * goes through `withActor`, which opens the transaction that sets the RLS GUCs,
 * and a nested transaction would either be a no-op or a second connection with
 * no `standfast.org_id` set at all.
 */
export async function recordReconciliation(
  db: Db,
  run: {
    orgId: string;
    projectId: string;
    actorId: string;
    trigger: ReconciliationTrigger;
    items: ReconcileItem[];
  },
): Promise<{ runId: string; recorded: number; open: number }> {
  const [inserted] = await db
    .insert(reconciliationRuns)
    .values({
      orgId: run.orgId,
      projectId: run.projectId,
      actorId: run.actorId,
      trigger: run.trigger,
      // Counted from the rows about to be written, never taken from the
      // request. This is the denominator of our own kill metric, and a
      // client-supplied count would let a caller improve our false-positive
      // rate by inflating it.
      verdictCount: run.items.length,
    })
    .returning({ id: reconciliationRuns.id });

  if (!inserted) {
    throw new Error("reconciliation run insert returned no row");
  }

  const findings = run.items.map((item) => ({
    orgId: run.orgId,
    projectId: run.projectId,
    runId: inserted.id,
    atomId: item.atomId,
    verdict: item.verdict,
    filePath: item.filePath,
    lineStart: item.lineStart ?? null,
    lineEnd: item.lineEnd ?? null,
    rationale: item.rationale ?? null,
    // The biconditional, applied once, in one place. The database enforces the
    // same rule as a check constraint — this is what makes the insert satisfy
    // it without any caller deciding what belongs in a human's queue.
    status: statusForVerdict(item.verdict),
  }));

  await db.insert(reconciliationFindings).values(findings);

  return {
    runId: inserted.id,
    recorded: findings.length,
    open: findings.filter((f) => f.status === "open").length,
  };
}

/**
 * The human queue, or the whole history of a project's findings.
 *
 * No `orgId` parameter. RLS supplies it from `standfast.org_id`, and a
 * repository that took one would be a second place the tenancy boundary is
 * decided — the first being the only one anybody audits.
 */
export async function listFindings(
  db: Db,
  projectId: string,
  status: Finding["status"] | undefined,
  page: Page,
): Promise<Paged<Finding>> {
  const rows = await db
    .select({
      ...getTableColumns(reconciliationFindings),
      pageTotal: PAGE_TOTAL,
    })
    .from(reconciliationFindings)
    .where(
      status
        ? and(
            eq(reconciliationFindings.projectId, projectId),
            eq(reconciliationFindings.status, status),
          )
        : eq(reconciliationFindings.projectId, projectId),
    )
    .orderBy(desc(reconciliationFindings.createdAt), reconciliationFindings.id)
    .limit(page.limit)
    .offset(page.offset);

  return paged(rows, page);
}

/**
 * A human answers one open finding.
 *
 * Two refusals are worth naming because neither is enforced here:
 *
 * `resolved_by_kind` is written as the literal `'human'`, and the composite
 * foreign key to `actors (id, kind)` is what refuses an agent — exactly as
 * `ratifyAtom` does. An agent dismissing a finding about its own edit is the
 * reconciliation-shaped version of promoting its own knowledge, and it fails in
 * the database rather than in whichever route remembered to check.
 *
 * The `status = 'open'` predicate is what makes this conditional rather than
 * idempotent: a second resolve returns no row, and the caller turns that into a
 * 409. There is no reopen transition, because the vocabulary has no state to
 * reopen *into* — that arrives with a finding-events table, and not before.
 */
export async function resolveFinding(
  db: Db,
  findingId: string,
  actorId: string,
  status: Extract<Finding["status"], "accepted" | "dismissed">,
): Promise<Finding | undefined> {
  const rows = await db
    .update(reconciliationFindings)
    .set({
      status,
      resolvedBy: actorId,
      resolvedByKind: "human",
      // The database's clock, for the same reason `ratifyAtom` uses it: one
      // clock, so these rows can be ordered against each other.
      resolvedAt: sql`now()`,
    })
    .where(
      and(
        eq(reconciliationFindings.id, findingId),
        eq(reconciliationFindings.status, "open"),
      ),
    )
    .returning();

  return rows[0];
}

/**
 * What is waiting on a human, in two numbers.
 *
 * `canonicalUnchecked` counts canonical atoms with no finding recorded since
 * they were last ratified. Deliberately a query and not a column: a
 * `last_checked_at` on `atoms`, or an `atom_check_state` table, would be a
 * cache of exactly this — invalidated by every ratification and by every run,
 * and wrong in the direction that hides work. `docs/07-reconciliation.md` lists
 * both under *Tables deliberately not added*.
 *
 * A count is also the honest maximum here. For a canonical atom nobody has
 * checked, the server cannot name the file to check it against, because naming
 * one would need a file tree it does not have.
 */
export async function countDrift(
  db: Db,
  projectId: string,
): Promise<{ openFindings: number; canonicalUnchecked: number }> {
  const [open] = await db
    .select({ n: count() })
    .from(reconciliationFindings)
    .where(
      and(
        eq(reconciliationFindings.projectId, projectId),
        eq(reconciliationFindings.status, "open"),
      ),
    );

  // "No finding since it was last ratified" rather than "no finding at all":
  // re-ratifying an atom is a new claim, and a check against the old wording is
  // not evidence about the new one. `ratified_at` is non-null for every
  // canonical atom — `atoms_canonical_requires_ratification` guarantees it — so
  // the comparison is never against null.
  const [unchecked] = await db
    .select({ n: count() })
    .from(atoms)
    .where(
      and(
        eq(atoms.projectId, projectId),
        eq(atoms.status, "canonical"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(reconciliationFindings)
            .where(
              and(
                eq(reconciliationFindings.atomId, atoms.id),
                gte(reconciliationFindings.createdAt, atoms.ratifiedAt),
              ),
            ),
        ),
      ),
    );

  return {
    openFindings: open?.n ?? 0,
    canonicalUnchecked: unchecked?.n ?? 0,
  };
}
