import {
  ATOM_EVENTS,
  ATOM_REJECT_REASONS,
  ATOM_STATUSES,
  EGRESS_PURPOSES,
  FINDING_STATUSES,
  FINDING_VERDICTS,
  RECONCILIATION_TRIGGERS,
} from "@standfast/core";
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Human or agent. This is not descriptive metadata — `actors` is unique on
 * `(id, kind)` so that `atoms` can carry a composite foreign key to
 * `(id, 'human')`. That is what makes "an agent cannot promote its own
 * knowledge" a database constraint rather than a code path.
 */
export const actorKind = pgEnum("actor_kind", ["human", "agent"]);

/**
 * `retired` is the fifth, and it exists because `rejected` has a job.
 *
 * `rejected` means *a human looked at a proposal and said no*, which is the
 * signal `docs/12-evaluation.md` measures extraction precision with. A canonical
 * atom the project has abandoned is not an extraction failure — it was right,
 * and the world moved on. Reusing `rejected` for both would inflate the
 * rejection rate with non-failures and put a correction on every precision query
 * forever. `docs/15-ratification.md` (*Open*) named the gap; migration 0012
 * closes it.
 *
 * Terminal, reachable only from `canonical`, and only by a human.
 */
export const atomStatus = pgEnum("atom_status", ATOM_STATUSES);

export const atomKind = pgEnum("atom_kind", [
  "decision",
  "convention",
  "constraint",
]);

export const atomEvent = pgEnum("atom_event", ATOM_EVENTS);

/**
 * Why a human rejected a proposal.
 *
 * The closed five of `docs/15-ratification.md` (*Reject*). An enum rather than
 * free-form text because the entire value of these labels is comparability
 * across projects — this is the labelled corpus extraction never had, produced
 * out of ordinary use rather than out of a labelling project nobody schedules.
 * `duplicate` on an atom deduplication failed to suppress is a threshold miss
 * with a timestamp on it.
 *
 * Optional, deliberately: a required field turns a decision into a form, and a
 * reviewer made to justify a rejection ratifies marginal atoms instead.
 */
export const atomRejectReason = pgEnum(
  "atom_reject_reason",
  ATOM_REJECT_REASONS,
);

/**
 * The outcome of one extraction run over one section.
 *
 * `running` exists so that a crashed worker leaves evidence. Recording only
 * terminal states would make an abandoned run indistinguishable from a section
 * nobody has reached yet, and those two need different repairs.
 */
export const extractionStatus = pgEnum("extraction_status", [
  "running",
  "succeeded",
  "failed",
]);

/**
 * What an outbound call was for.
 *
 * Built from `EGRESS_PURPOSES` rather than repeating it, so the column and the
 * policy that governs it cannot drift apart. Every value is here, including the
 * two no deployment may configure — `reranking` and `query-embedding`: this
 * column records what a call *was* for, and a purpose the type cannot express
 * is a call that would have to be written down as something it was not.
 * Whether a purpose may be configured at all is `PERMITTED_PURPOSES`, in core,
 * and this enum is deliberately not that check.
 *
 * Counting them in this comment was a mistake once already — it said "all four"
 * and stayed saying it while a fifth was added — so it does not count them now.
 */
export const egressPurpose = pgEnum("egress_purpose", EGRESS_PURPOSES);

/**
 * Which loop produced a reconciliation run.
 *
 * Self-reported by the client, so it is analytics and never control. Nothing
 * gates on it and no policy reads it — it is recorded because tuning the loop
 * without knowing which trigger produces the noise is tuning blind.
 */
export const reconciliationTrigger = pgEnum(
  "reconciliation_trigger",
  RECONCILIATION_TRIGGERS,
);

/**
 * What one check of one atom against one file concluded.
 *
 * Built from core's `FINDING_VERDICTS` rather than repeating the four literals,
 * for the same reason `egressPurpose` is built from `EGRESS_PURPOSES`: the
 * column and the code that validates writes into it cannot drift apart if
 * there is only one list.
 *
 * There is no `partially_honored`. A violation that applies to part of a file
 * is a violation, and a vocabulary that offers a hedge gets one.
 */
export const findingVerdict = pgEnum("finding_verdict", FINDING_VERDICTS);

/**
 * Where a finding sits in the human queue.
 *
 * `recorded` is the terminal state of every non-violation rather than a queue
 * state. Which of these a row may hold is not free: migration 0009 ties it to
 * the verdict with a biconditional, so exactly the violations are queued and
 * every violation is.
 */
export const findingStatus = pgEnum("finding_status", FINDING_STATUSES);
