-- Reverses 0013_decision_is_human.sql.
--
-- What this costs: "only a human decides" stops being a database guarantee for
-- `atom_events` and goes back to being a predicate in a repository and a 403 in
-- a route. Both still exist and both still work — but an agent that reaches the
-- table by any other path can write `rejected` or `retired` again, and nothing
-- underneath says no.
--
-- The rows keep their history; only the enforcement goes. Dropping the column
-- does lose the record of *what kind* of actor wrote each past event, which is
-- not recoverable for a row whose actor has since been deleted.
--
-- Order is the mirror of the up: the check and the foreign key both depend on
-- the column, and the trigger depends on the function.
ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_decision_is_human";--> statement-breakpoint
ALTER TABLE "atom_events" DROP CONSTRAINT IF EXISTS "atom_events_actor_kind_fk";--> statement-breakpoint
DROP TRIGGER IF EXISTS "atom_events_actor_kind_insert" ON "atom_events";--> statement-breakpoint
DROP FUNCTION IF EXISTS "atom_events_set_actor_kind"();--> statement-breakpoint
ALTER TABLE "atom_events" DROP COLUMN IF EXISTS "actor_kind";
