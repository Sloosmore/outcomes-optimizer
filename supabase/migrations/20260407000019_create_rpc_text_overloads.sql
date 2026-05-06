-- Add text-parameter overloads for create_agent, create_proxy, create_skill
-- The goal criterion proof commands call these RPCs with (text, text::text, jsonb)
-- but the primary functions use uuid for p_project_id.
-- These overloads accept text project_id and delegate to the uuid versions.
-- Permissions aligned with 000017 revokes; GRANT EXECUTE TO service_role added for service access.
-- REVOKE/GRANT statements are idempotent no-ops on re-run (revoking a privilege not held or
-- granting one already held is a no-op in Postgres).
-- Supabase auto-grants EXECUTE to anon/authenticated on new functions in addition to PUBLIC,
-- so both REVOKE FROM PUBLIC and REVOKE FROM anon, authenticated are required.
--
-- DROP FUNCTION IF EXISTS guards: a prior environment may already have these
-- text overloads with a different parameter default (e.g. `p_config DEFAULT '{}'`).
-- Postgres rejects CREATE OR REPLACE that removes a default, so drop-then-create
-- is the only way to make this migration idempotent across all states.
-- p_config intentionally has no DEFAULT here (matches original 000019 intent); migration 000022
-- restores DEFAULT '{}'::jsonb on the superseding standalone implementation.
-- DROP uses RESTRICT (the default) deliberately: fail loudly if any dependent objects exist
-- rather than silently cascading drops.

-- create_agent text overload
DROP FUNCTION IF EXISTS public.create_agent(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_agent(p_name text, p_project_id text, p_config jsonb)
RETURNS TABLE(agent_resource_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uuid uuid;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'p_name must not be null or empty' USING ERRCODE = '22023';
  END IF;
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id must not be null' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_uuid := p_project_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid UUID value for p_project_id: %', p_project_id USING ERRCODE = '22023';
  END;
  RETURN QUERY SELECT * FROM public.create_agent(p_name, v_uuid, p_config);
END;
$$;
REVOKE ALL ON FUNCTION public.create_agent(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_agent(text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent(text, text, jsonb) TO service_role;

-- create_proxy text overload
DROP FUNCTION IF EXISTS public.create_proxy(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_proxy(p_name text, p_project_id text, p_config jsonb)
RETURNS TABLE(proxy_resource_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uuid uuid;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'p_name must not be null or empty' USING ERRCODE = '22023';
  END IF;
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id must not be null' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_uuid := p_project_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid UUID value for p_project_id: %', p_project_id USING ERRCODE = '22023';
  END;
  RETURN QUERY SELECT * FROM public.create_proxy(p_name, v_uuid, p_config);
END;
$$;
REVOKE ALL ON FUNCTION public.create_proxy(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_proxy(text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_proxy(text, text, jsonb) TO service_role;

-- create_skill text overload
DROP FUNCTION IF EXISTS public.create_skill(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(p_name text, p_project_id text, p_config jsonb)
RETURNS TABLE(skill_resource_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uuid uuid;
BEGIN
  IF p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'p_name must not be null or empty' USING ERRCODE = '22023';
  END IF;
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id must not be null' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_uuid := p_project_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid UUID value for p_project_id: %', p_project_id USING ERRCODE = '22023';
  END;
  RETURN QUERY SELECT * FROM public.create_skill(p_name, v_uuid, p_config);
END;
$$;
REVOKE ALL ON FUNCTION public.create_skill(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_skill(text, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_skill(text, text, jsonb) TO service_role;
