-- Helper function to look up server resource info by name for deprovision flow.
-- SECURITY DEFINER bypasses RLS — the CLI authenticated user needs to read server
-- config (hetzner_server_id) before calling provider.deprovision().
DROP FUNCTION IF EXISTS public.get_sandbox_server_info(text);
CREATE OR REPLACE FUNCTION public.get_sandbox_server_info(
  p_server_name TEXT
)
RETURNS TABLE(server_resource_id UUID, hetzner_server_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT id AS server_resource_id, config->>'hetzner_server_id' AS hetzner_server_id
  FROM public.resources
  WHERE name = p_server_name AND type = 'server'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_sandbox_server_info(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sandbox_server_info(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_sandbox_server_info(TEXT) TO authenticated;
