-- Reverses 0012_retired_status.sql.
--
-- Postgres cannot drop a value from an enum, so narrowing one means building the
-- type again without the value and re-typing every column declared with it —
-- the same manoeuvre `0008_query_egress_purpose.down.sql` performs.
--
-- It is longer here than it was there, and the extra length is the point:
-- `atom_status` and `atom_event` have *dependents*, which `egress_purpose` did
-- not. A check constraint and a partial index both carry an explicit
-- `::atom_status` cast, and a re-typed column leaves those casts pointing at the
-- old type — `operator does not exist: atom_status_old = atom_status`. Each one
-- therefore has to be dropped before the cast and rebuilt after it, from the
-- definition `pg_get_constraintdef` and `pg_indexes` report today. A narrowing
-- that forgets one of them fails loudly; a narrowing that forgets to *rebuild*
-- one succeeds and silently drops a guarantee, which is worse.
--
-- **This fails, deliberately, if any atom is retired or any event says
-- `retired`.** The `USING` cast has nothing to map those rows onto. The honest
-- outcome is a migration that refuses rather than one that quietly rewrites a
-- human's decision into some other status; an operator who means it has to say
-- what should become of those rows first.

-- ── atoms.status ──────────────────────────────────────────────────────────
ALTER TABLE "atoms" DROP CONSTRAINT "atoms_canonical_requires_ratification";--> statement-breakpoint
DROP INDEX "atoms_structural_idx";--> statement-breakpoint
ALTER TABLE "atoms" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint

CREATE TYPE "public"."atom_status_old" AS ENUM('provisional', 'canonical', 'rejected', 'superseded');--> statement-breakpoint
ALTER TABLE "atoms" ALTER COLUMN "status" TYPE "public"."atom_status_old" USING "status"::text::"public"."atom_status_old";--> statement-breakpoint
DROP TYPE "public"."atom_status";--> statement-breakpoint
ALTER TYPE "public"."atom_status_old" RENAME TO "atom_status";--> statement-breakpoint

ALTER TABLE "atoms" ALTER COLUMN "status" SET DEFAULT 'provisional';--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_canonical_requires_ratification" CHECK (status <> 'canonical' OR (ratified_by IS NOT NULL AND ratified_at IS NOT NULL));--> statement-breakpoint
CREATE INDEX "atoms_structural_idx" ON "atoms" USING btree ("project_id","kind","created_at" DESC) WHERE status = 'canonical';--> statement-breakpoint

-- ── atom_events.event ─────────────────────────────────────────────────────
--
-- 0011's check is dropped and rebuilt here rather than in 0011's own down,
-- because downs run newest first: this file executes while that constraint still
-- exists, and it carries an `::atom_event` cast of its own.
ALTER TABLE "atom_events" DROP CONSTRAINT "atom_events_reason_only_on_reject";--> statement-breakpoint

CREATE TYPE "public"."atom_event_old" AS ENUM('proposed', 'ratified', 'rejected', 'superseded');--> statement-breakpoint
ALTER TABLE "atom_events" ALTER COLUMN "event" TYPE "public"."atom_event_old" USING "event"::text::"public"."atom_event_old";--> statement-breakpoint
DROP TYPE "public"."atom_event";--> statement-breakpoint
ALTER TYPE "public"."atom_event_old" RENAME TO "atom_event";--> statement-breakpoint

ALTER TABLE "atom_events" ADD CONSTRAINT "atom_events_reason_only_on_reject" CHECK (("reason" IS NULL AND "reason_note" IS NULL) OR "event" = 'rejected');
