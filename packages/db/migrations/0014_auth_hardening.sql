-- Two authentication hardenings docs/13-threat-model.md carried as open,
-- both cheap.
--
-- 1. `api_keys.hash` had no index. `auth.resolve_api_key` was a sequential
--    scan on every authenticated request, while the comment justifying
--    SHA-256 in `packages/db/src/auth.ts` described the lookup as indexed —
--    and its `LIMIT 1` would have resolved a duplicate hash arbitrarily.
--    The index is UNIQUE, so a duplicate is unrepresentable rather than
--    resolved by chance. Existing rows cannot collide: a hash is SHA-256 of
--    256 fresh random bits.
--
-- 2. The pinned `search_path` did not name `pg_temp`. Postgres searches the
--    temporary schema ahead of every listed schema for relation names unless
--    `pg_temp` is placed explicitly, so the convention for SECURITY DEFINER
--    is to list it last. The body's `public.api_keys` qualification already
--    resolved correctly — but the qualification was doing that work, not the
--    pin, and an edit dropping the qualification would have reopened the hole
--    silently. ALTER rather than CREATE OR REPLACE: the body is untouched and
--    the owner (`standfast_auth`) stays put.

CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys" USING btree ("hash");--> statement-breakpoint

ALTER FUNCTION "auth"."resolve_api_key"(text) SET search_path = pg_catalog, public, pg_temp;
