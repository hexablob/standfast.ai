-- Reverse of 0000_foundation.sql, hand-written.
--
-- drizzle-kit generates forward-only SQL, so this half is written by hand and
-- CI runs up -> down -> up against a throwaway database. A migration that
-- cannot survive that round trip does not merge.
--
-- Order matters: privileges must be revoked before the role can be dropped,
-- and the role cannot be dropped while it still holds a grant on the schema.

DROP TABLE IF EXISTS "atom_events" CASCADE;
DROP TABLE IF EXISTS "atoms" CASCADE;
DROP TABLE IF EXISTS "document_sections" CASCADE;
DROP TABLE IF EXISTS "documents" CASCADE;
DROP TABLE IF EXISTS "projects" CASCADE;
DROP TABLE IF EXISTS "api_keys" CASCADE;
DROP TABLE IF EXISTS "actors" CASCADE;
DROP TABLE IF EXISTS "orgs" CASCADE;

DROP TYPE IF EXISTS "public"."atom_event";
DROP TYPE IF EXISTS "public"."atom_status";
DROP TYPE IF EXISTS "public"."atom_kind";
DROP TYPE IF EXISTS "public"."actor_kind";

-- The tables took their own grants with them; this is the schema-level one.
DO $$ BEGIN
	REVOKE USAGE ON SCHEMA "public" FROM "standfast_app";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- The test harness grants standfast_app to a login role; that membership would
-- otherwise block the drop.
DROP ROLE IF EXISTS "standfast_test";
DROP ROLE IF EXISTS "standfast_app";

DROP EXTENSION IF EXISTS "pg_trgm";
DROP EXTENSION IF EXISTS "vector";
