-- The extractor actor, and a column that can name it.
--
-- docs/05-extraction.md requires one actor per org with kind = 'agent' to
-- attribute extracted atoms to. It declines the two obvious alternatives: a
-- null actor, which breaks the append-only event log the phase-4 throughput
-- metric is computed from, and the pushing human's actor, which attributes a
-- model's output to a person -- the one attribution error this system cannot
-- afford.
--
-- What it did not settle is how anything finds that actor. `display_name` was
-- the only handle, and it is editable, so a worker resolving its own identity
-- by name would stop working the moment somebody tidied a list. `system_key`
-- is that handle: null for every actor a person creates, unique within an org,
-- and never shown as a name.
ALTER TABLE "actors" ADD COLUMN "system_key" text;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_org_system_key_key" UNIQUE("org_id","system_key");--> statement-breakpoint
-- Backfilled for every org that already exists, so the worker never has to
-- decide whether to create an actor from inside a job. Creating identities
-- lazily, under load, from a process that is meant to be a recommender is the
-- kind of write that turns into two identities under a race.
INSERT INTO "actors" ("org_id", "kind", "display_name", "system_key")
SELECT "id", 'agent', 'Extractor', 'extractor' FROM "orgs"
ON CONFLICT ("org_id", "system_key") DO NOTHING;
