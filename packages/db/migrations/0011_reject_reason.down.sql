-- Reverses 0011_reject_reason.sql.
--
-- What this costs: every rejection reason recorded so far. `atom_events` is
-- append-only precisely so that decisions cannot be unmade, and these columns
-- are the labelled corpus `docs/12-evaluation.md` gets out of ordinary use
-- rather than out of a labelling project. Dropping them does not reset that
-- corpus, it deletes it, and no re-run recovers a judgement a human made once.
--
-- The rows themselves survive — the events are still there and still say a
-- human rejected an atom. What is lost is *why*, which is the half that makes
-- them worth anything to extraction precision.
--
-- Constraints first, then the columns they constrain, then the type the column
-- is declared with. Any other order fails on a dependency.
ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_reason_note_shape";--> statement-breakpoint
ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_reason_only_on_reject";--> statement-breakpoint
ALTER TABLE "atom_events" DROP COLUMN IF EXISTS "reason_note";--> statement-breakpoint
ALTER TABLE "atom_events" DROP COLUMN IF EXISTS "reason";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."atom_reject_reason";
