-- The queue's schema, its ownership, and who may touch what in it.
--
-- Hand-written; drizzle-kit knows nothing about this schema and never will.
-- The split is deliberate: this repository owns the *schema*, its ownership and
-- its grants, and pg-boss owns the objects inside it. Vendoring pg-boss's ~600
-- lines of generated DDL into a migration would put a ledger it already keeps
-- -- packageJson.pgboss.schema, and detectSchemaDrift() -- into a second ledger
-- that can silently disagree with the first, and would have to be transcribed
-- by hand on every version bump. Its create plan also wraps itself in
-- BEGIN/COMMIT and takes an advisory lock, and drizzle-kit runs each migration
-- file inside its own transaction, so the embedded COMMIT would close drizzle's
-- transaction early and orphan its bookkeeping insert.
--
-- The cost, stated plainly: `pnpm db:migrate` alone no longer produces a
-- working database. `pnpm db:queue:install` is a second, required step, and it
-- runs as the owner over DIRECT_URL.
CREATE SCHEMA IF NOT EXISTS "pgboss";--> statement-breakpoint

-- USAGE, and never CREATE. The restricted role sends and fetches jobs; it does
-- not get to declare queues at runtime. With CREATE withheld, a createQueue()
-- call from a serving process fails with a permission error instead of quietly
-- succeeding -- which is the difference between "queues are declared at install
-- time" and "queues are declared at install time, so far".
GRANT USAGE ON SCHEMA "pgboss" TO "standfast_app";--> statement-breakpoint

-- The tables do not exist yet; the install step creates them. Default
-- privileges are what makes these grants outlive that step, and they attach to
-- the role that runs this migration -- the same role that runs the install,
-- both over DIRECT_URL.
ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "standfast_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
  GRANT USAGE, SELECT ON SEQUENCES TO "standfast_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "pgboss"
  GRANT EXECUTE ON FUNCTIONS TO "standfast_app";
