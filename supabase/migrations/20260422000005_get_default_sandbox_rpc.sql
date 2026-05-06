-- Migration: get_default_sandbox SECURITY DEFINER RPC
-- Story 3: Returns the first server resource owned by the calling user (by created_at ASC)
-- Returns NULL if the user has no sandbox. RLS-scoped via auth.uid().

-- A. Implement get_default_sandbox(auth_uid UUID DEFAULT auth.uid())
-- Traverses: user resource → resource_links (parent) → server resource
-- Returns the first server resource row (created_at ASC) owned by the user.
-- Returns empty set if user has no sandbox — never raises.
DROP FUNCTION IF EXISTS public.get_default_sandbox(uuid);
CREATE OR REPLACE FUNCTION public.get_default_sandbox(
  p_auth_uid UUID DEFAULT auth.uid()
)
RETURNS TABLE(server_resource_id UUID, server_ip TEXT, server_config JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
BEGIN
  -- Resolve caller's user resource by external_id (auth UID stored in name as 'user:<uid>')
  SELECT id INTO v_user_resource_id
  FROM public.resources
  WHERE type = 'user'
    AND name = 'user:' || p_auth_uid::text;

  -- No user resource → return empty (never raise)
  IF v_user_resource_id IS NULL THEN
    RETURN;
  END IF;

  -- Walk: resource_links WHERE to_id=user.id AND link_type='parent' → server resources
  -- Return the first server resource ordered by created_at ASC
  RETURN QUERY
  SELECT
    r.id AS server_resource_id,
    (r.config->>'ip') AS server_ip,
    r.config AS server_config
  FROM public.resource_links rl
  JOIN public.resources r
    ON r.id = rl.from_id AND r.type = 'server'
  WHERE rl.to_id = v_user_resource_id
    AND rl.link_type = 'parent'
  ORDER BY r.created_at ASC
  LIMIT 1;
END;
$$;

-- B. Grant EXECUTE to authenticated and service_role
REVOKE ALL ON FUNCTION public.get_default_sandbox(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_default_sandbox(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_default_sandbox(UUID) TO service_role;

-- C. Smoke test: verify function exists and returns empty for a nonexistent user
DO $smoke_test$
DECLARE
  v_fake_uid UUID := '00000000-0000-0000-0000-000000000002';
  v_count INT;
BEGIN
  -- get_default_sandbox with no matching user resource should return 0 rows
  SELECT COUNT(*) INTO v_count
  FROM public.get_default_sandbox(v_fake_uid);

  IF v_count != 0 THEN
    RAISE EXCEPTION 'Smoke test FAILED: get_default_sandbox returned rows for nonexistent user';
  END IF;

  RAISE NOTICE 'Smoke test PASSED: get_default_sandbox returns empty for nonexistent user';
END;
$smoke_test$;
