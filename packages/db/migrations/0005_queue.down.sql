-- Reverses 0005_queue.sql.
--
-- CASCADE takes pg-boss's tables with the schema, and with them every queued
-- job. That is correct for a down migration and worth saying out loud: rolling
-- this back on a database with work in flight discards that work. The atoms
-- already written are untouched, and the sections whose jobs were dropped have
-- no section_extractions row, so re-running extraction re-enqueues exactly
-- them. The queue is recoverable state; that is why it is allowed to be
-- destroyed here.
--
-- Guarded on the schema existing, and not for tidiness. ALTER DEFAULT
-- PRIVILEGES raises on a schema that is not there, so an unguarded revoke makes
-- this file fail the second time it runs -- which is precisely what CI's
-- up/down/up round trip does when an earlier attempt left the database
-- half-torn-down. A down migration that only works from a pristine state is a
-- down migration you cannot use on the day you need it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
      REVOKE EXECUTE ON FUNCTIONS FROM "standfast_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
      REVOKE USAGE, SELECT ON SEQUENCES FROM "standfast_app";
    ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM "standfast_app";
  END IF;
END $$;--> statement-breakpoint
DROP SCHEMA IF EXISTS "pgboss" CASCADE;
