-- Reverses 0009_reconciliation.sql.
--
-- What this costs, stated plainly: it destroys every finding and every run, and
-- those rows are the only evidence this project has about its own kill metric.
-- The phase-3 exit criterion is a false-positive rate below 5%; the numerator is
-- the dismissed findings and the denominator is `verdict_count`. Dropping these
-- tables does not reset that measurement, it deletes it — a fresh database
-- cannot tell "we have never measured" from "we measured and it was bad".
--
-- Findings are also append-mostly by grant: `standfast_app` has no DELETE on
-- either table precisely so that nothing on the request path can do a narrower
-- version of this. Running this file is a deliberate act by an operator with
-- owner rights, which is the only level at which discarding that evidence
-- should be possible at all.
--
-- Order matters: findings reference runs, so findings go first. The enum types
-- go last, after the columns typed by them are gone. And `atoms` has to be put
-- back the way 0008 left it — 0009 added a unique pair to it so that a finding
-- could carry a composite foreign key naming the atom's project, and a down
-- that dropped the tables but left the constraint behind would fail the next
-- `up` with "constraint already exists". A migration that only reverses
-- cleanly the first time is not reversible.
DROP TABLE IF EXISTS "reconciliation_findings";--> statement-breakpoint
DROP TABLE IF EXISTS "reconciliation_runs";--> statement-breakpoint
ALTER TABLE "atoms" DROP CONSTRAINT IF EXISTS "atoms_id_project_key";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_id_org_key";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."finding_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."finding_verdict";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."reconciliation_trigger";
