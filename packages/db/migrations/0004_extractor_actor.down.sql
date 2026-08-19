-- Reverses 0004_extractor_actor.sql.
--
-- The backfilled rows are deleted before the column goes, and only those rows:
-- `system_key = 'extractor'` is the whole selection, so an actor a person
-- created is never touched. An atom_events row may reference one of them, and
-- its foreign key will refuse the delete rather than cascade -- correct, and
-- loud. A database that has extracted anything cannot roll this migration back
-- without deciding what to do with the evidence, which is the honest position
-- for a down migration to take.
DELETE FROM "actors" WHERE "system_key" = 'extractor';--> statement-breakpoint
ALTER TABLE "actors" DROP CONSTRAINT "actors_org_system_key_key";--> statement-breakpoint
ALTER TABLE "actors" DROP COLUMN "system_key";
