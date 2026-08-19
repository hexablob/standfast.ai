-- Reverse of 0001_auth.sql, hand-written.

DROP FUNCTION IF EXISTS "auth"."resolve_api_key"(text);

DROP POLICY IF EXISTS "api_keys_auth_lookup" ON "public"."api_keys";

DO $$ BEGIN
	REVOKE SELECT ON "public"."api_keys" FROM "standfast_auth";
EXCEPTION WHEN undefined_object OR undefined_table THEN NULL;
END $$;

DROP SCHEMA IF EXISTS "auth" CASCADE;

DROP ROLE IF EXISTS "standfast_auth";
