/**
 * The atom lifecycle vocabulary.
 *
 * Here rather than in the schema for the same reason `EGRESS_PURPOSES` and
 * `FINDING_VERDICTS` are here: three separate things have to agree on these
 * words — the Postgres enums, the request and response schemas the API
 * validates against, and the tests that pin both — and a vocabulary written
 * down three times is a vocabulary that drifts twice.
 *
 * It drifted once already. `retired` was added to the database enum and the API
 * kept validating against four values, which the type checker caught only
 * because the row type flowed into a handler. Building both from one array is
 * what makes that a compile error at the source rather than a runtime 500 the
 * day somebody retires an atom.
 *
 * Pure domain: no I/O.
 */

/**
 * `retired` exists because `rejected` has a job.
 *
 * `rejected` means *a human looked at a proposal and said no* — the signal
 * `docs/12-evaluation.md` measures extraction precision with. An atom the
 * project has abandoned is not an extraction failure; it was right, and the
 * world moved on. `docs/15-ratification.md` (*Open*) named the gap and migration
 * 0012 closes it with a fifth status rather than a fifth meaning for the fourth.
 */
export const ATOM_STATUSES = [
  "provisional",
  "canonical",
  "rejected",
  "superseded",
  "retired",
] as const;

export type AtomStatus = (typeof ATOM_STATUSES)[number];

/** One entry in the append-only ledger the throughput metric reads. */
export const ATOM_EVENTS = [
  "proposed",
  "ratified",
  "rejected",
  "superseded",
  "retired",
] as const;

export type AtomEvent = (typeof ATOM_EVENTS)[number];

/**
 * Why a human rejected a proposal — the closed five of
 * `docs/15-ratification.md` (*Reject*).
 *
 * Closed rather than free-form because the entire value of these labels is
 * comparability across projects: this is the labelled corpus extraction never
 * had, produced out of ordinary use rather than out of a labelling project
 * nobody schedules. `duplicate` on an atom deduplication failed to suppress is a
 * threshold miss with a timestamp on it.
 *
 * Optional at every layer, deliberately. A required field turns a decision into
 * a form, and a reviewer made to justify a rejection ratifies marginal atoms
 * instead — the precise failure the ratification document is written against.
 */
export const ATOM_REJECT_REASONS = [
  "not_true",
  "duplicate",
  "not_a_decision",
  "wrong_severity",
  "document_is_wrong",
] as const;

export type AtomRejectReason = (typeof ATOM_REJECT_REASONS)[number];
