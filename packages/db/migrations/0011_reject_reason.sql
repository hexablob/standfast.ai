-- The rejection vocabulary, and the reason it is worth a migration.
--
-- `docs/15-ratification.md` (*Reject*) settles this. Phase 4 adds a reject route
-- because clearance counts half a reviewer's work without one: a queue drains by
-- two decisions and only one of them was routed, so the throughput metric
-- `docs/02-principles.md` (5) calls first-class was measuring half the job.
--
-- **The vocabulary is the labelled corpus extraction never had.**
-- `docs/12-evaluation.md` notes that ratification throughput is the only one of
-- the four numbers with no labelled corpus, because the human's decision *is*
-- the label. Given a reason, the same click labels extraction precision and
-- dedup recall for free — `duplicate` on an atom deduplication did not suppress
-- is a threshold miss with a timestamp on it. That is how
-- `docs/02-principles.md` (10) gets its corpus: out of ordinary use, rather than
-- out of a labelling project nobody schedules.
--
-- A Postgres enum rather than free-form text, because the value of these labels
-- is entirely in their comparability across projects. Extending the vocabulary
-- later is one `ALTER TYPE`; ungluing a per-org lookup table is not.
--
-- **Optional, and that is load-bearing.** A required field converts a decision
-- into a form, and a reviewer who must justify a rejection ratifies marginal
-- atoms instead — the precise failure the ratification document is written
-- against. Cheap decisions must stay cheap.
--
-- **No grant change.** `standfast_app` keeps `SELECT, INSERT` on `atom_events`
-- and nothing more. Both columns are written at insert time, which is what keeps
-- the history reconstructable without making the log amendable.
CREATE TYPE "public"."atom_reject_reason" AS ENUM('not_true', 'duplicate', 'not_a_decision', 'wrong_severity', 'document_is_wrong');--> statement-breakpoint

ALTER TABLE "atom_events" ADD COLUMN "reason" "atom_reject_reason";--> statement-breakpoint

-- The free half of the pair. Capped at the same 280 characters as the
-- reconciliation rationale, so the two free-text fields in this system are under
-- one number rather than two.
--
-- What it deliberately does *not* carry is the control-character refusal that
-- `isSubmittableRationale` applies. That rule exists because a reconciliation
-- rationale is written by an **agent** and read by a human — an instruction
-- channel (`docs/02-principles.md`, 13) — and a pasted snippet had to be made
-- not to fit. This note is written by the human doing the rejecting, for their
-- own record and for the corpus. There is no agent on this path and therefore
-- no channel to close.
ALTER TABLE "atom_events" ADD COLUMN "reason_note" text;--> statement-breakpoint

-- A reason on `proposed` or `ratified` means nothing, and this is what stops it
-- meaning something later by accident.
ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_reason_only_on_reject" CHECK (("reason" IS NULL AND "reason_note" IS NULL) OR "event" = 'rejected');--> statement-breakpoint

ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_reason_note_shape" CHECK ("reason_note" IS NULL OR (length(btrim("reason_note")) > 0 AND length("reason_note") <= 280));
