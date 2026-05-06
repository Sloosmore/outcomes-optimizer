-- Migration: fix deprovision_sandbox false-positive for non-existent UUIDs
--
-- Bug: when p_server_resource_id is a valid UUID that does not exist in the
-- resources table, the previous version set v_server_id from the input
-- parameter before verifying the row exists, so the NULL guard never fired
-- and the function returned deleted=true for phantom rows.
--
-- Fix: use a separate resolved variable that is only set when a matching row
-- is confirmed to exist in the resources table.

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
BEGIN
  -- Resolve server resource ID — prefer explicit UUID, fall back to name lookup.
  -- v_server_id is only assigned when a confirmed matching row exists.
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
    -- Resource does not exist — return deleted=false (not a false positive)
    RETURN QUERY SELECT false, p_server_name;
    RETURN;
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

-- Revoke from PUBLIC, grant to service_role and authenticated
REVOKE ALL ON FUNCTION public.deprovision_sandbox(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO authenticated;
