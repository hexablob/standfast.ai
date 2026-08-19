-- Authentication bootstrap: resolving an API key to (org_id, actor_id) has to
-- happen *before* any tenant context exists, which is exactly what row-level
-- security keys on.
--
-- SECURITY DEFINER alone does not solve this. 0000 set FORCE ROW LEVEL
-- SECURITY, and FORCE subjects the table owner to policies too — so a definer
-- function owned by the migration role would still evaluate
--   org_id = nullif(current_setting('standfast.org_id', true), '')::uuid
-- which is NULL during authentication, and would return zero rows every time.
--
-- The exception therefore stays *inside* RLS: a dedicated NOLOGIN role with
-- one narrow SELECT policy, and a function that runs as that role and returns
-- three columns. Nothing else ever runs as standfast_auth.
--
-- If the lookup ever returns nothing, the fix is this policy. It is never
-- dropping FORCE.

CREATE SCHEMA IF NOT EXISTS "auth";--> statement-breakpoint

DO $$ BEGIN
	CREATE ROLE "standfast_auth" NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- The migration role must hold the role to be allowed to hand it ownership.
DO $$ BEGIN
	EXECUTE format('GRANT "standfast_auth" TO %I', current_user);
END $$;--> statement-breakpoint

GRANT SELECT ON "public"."api_keys" TO "standfast_auth";--> statement-breakpoint

-- Scoped TO standfast_auth, so standfast_app is untouched and still cannot read
-- api_keys without a tenant. No org predicate, because there is no org yet.
--
-- Revocation and expiry live here rather than in application code: an expired
-- key is invisible to the lookup, not filtered by a condition someone could
-- later reorder or forget.
CREATE POLICY "api_keys_auth_lookup" ON "public"."api_keys"
	AS PERMISSIVE FOR SELECT TO "standfast_auth"
	USING (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()));--> statement-breakpoint

-- search_path is pinned. An unpinned search_path on a SECURITY DEFINER
-- function is a privilege-escalation primitive, not a style preference.
CREATE FUNCTION "auth"."resolve_api_key"(key_hash text)
	RETURNS TABLE (org_id uuid, actor_id uuid, scopes text[])
	LANGUAGE sql
	STABLE
	SECURITY DEFINER
	SET search_path = pg_catalog, public
AS $$
	SELECT k.org_id, k.actor_id, k.scopes
	FROM public.api_keys k
	WHERE k.hash = key_hash
	LIMIT 1;
$$;--> statement-breakpoint

ALTER FUNCTION "auth"."resolve_api_key"(text) OWNER TO "standfast_auth";--> statement-breakpoint

REVOKE ALL ON FUNCTION "auth"."resolve_api_key"(text) FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "auth" TO "standfast_app";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "auth"."resolve_api_key"(text) TO "standfast_app";
