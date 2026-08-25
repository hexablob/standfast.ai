-- Reverse of 0014_auth_hardening.sql, hand-written.

ALTER FUNCTION "auth"."resolve_api_key"(text) SET search_path = pg_catalog, public;

DROP INDEX IF EXISTS "api_keys_hash_key";
