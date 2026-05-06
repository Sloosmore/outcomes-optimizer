-- Migration: add ownership checks to deprovision_sandbox and get_sandbox_server_info
-- Security: SECURITY DEFINER functions must verify auth.uid() owns the resource
-- Context: server resources are linked to user resources via resource_links(from_id=server, to_id=user, link_type='parent')
-- User resources are named 'user:<auth_user_id>' with type='user'

-- Fix deprovision_sandbox: add ownership check before deleting
DROP FUNCTION IF EXISTS public.deprovision_sandbox(uuid, text);
CREATE OR REPLACE FUNCTION public.deprovision_sandbox(
  p_server_resource_id UUID DEFAULT NULL,
  p_server_name TEXT DEFAULT NULL
)
RETURNS TABLE(deleted BOOLEAN, server_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_server_id UUID;
  v_server_name TEXT;
  v_credential_id UUID;
  v_caller_user_resource_id UUID;
BEGIN
  -- Resolve server resource ID — prefer explicit UUID, fall back to name lookup.
  -- v_server_id is only assigned when a confirmed matching row exists (avoids false-positive).
  IF p_server_resource_id IS NOT NULL THEN
    SELECT id, name INTO v_server_id, v_server_name
    FROM public.resources
    WHERE id = p_server_resource_id AND type = 'server';
  ELSIF p_server_name IS NOT NULL THEN
    SELECT id, name INTO v_server_id, v_server_name
    FROM public.resources
    WHERE name = p_server_name AND type = 'server';
  END IF;

  IF v_server_id IS NULL THEN
    -- Nothing to delete — return deleted=false
    RETURN QUERY SELECT false, p_server_name;
    RETURN;
  END IF;

  -- Ownership check: verify auth.uid() owns this server resource
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id::text = auth.uid()::text
    AND type = 'user';

  IF v_caller_user_resource_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = v_server_id
      AND to_id = v_caller_user_resource_id
      AND link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this sandbox'
      USING ERRCODE = '42501';
  END IF;

  -- Find the credential resource linked to this server (link_type = 'credential')
  SELECT to_id INTO v_credential_id
  FROM public.resource_links
  WHERE from_id = v_server_id AND link_type = 'credential'
  LIMIT 1;

  -- Delete all resource_links where server is either side
  DELETE FROM public.resource_links
  WHERE from_id = v_server_id OR to_id = v_server_id;

  -- Delete credential resource (if found and not shared)
  IF v_credential_id IS NOT NULL THEN
    DELETE FROM public.resources WHERE id = v_credential_id;
  END IF;

  -- Delete server resource itself
  DELETE FROM public.resources WHERE id = v_server_id;

  RETURN QUERY SELECT true, v_server_name;
END;
$$;

-- Fix get_sandbox_server_info: add ownership check
DROP FUNCTION IF EXISTS public.get_sandbox_server_info(text);
CREATE OR REPLACE FUNCTION public.get_sandbox_server_info(
  p_server_name TEXT
)
RETURNS TABLE(server_resource_id UUID, hetzner_server_id TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_server_id UUID;
  v_hetzner_id TEXT;
  v_caller_user_resource_id UUID;
BEGIN
  -- Look up the server
  SELECT id, config->>'hetzner_server_id' INTO v_server_id, v_hetzner_id
  FROM public.resources
  WHERE name = p_server_name AND type = 'server';

  IF v_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Ownership check: verify auth.uid() owns this server resource
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id::text = auth.uid()::text
    AND type = 'user';

  IF v_caller_user_resource_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = v_server_id
      AND to_id = v_caller_user_resource_id
      AND link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this sandbox'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT v_server_id, v_hetzner_id;
END;
$$;

REVOKE ALL ON FUNCTION public.deprovision_sandbox(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_sandbox_server_info(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sandbox_server_info(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_sandbox_server_info(TEXT) TO authenticated;
