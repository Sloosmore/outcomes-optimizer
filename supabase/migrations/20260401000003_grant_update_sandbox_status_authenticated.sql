-- Grant update_sandbox_status to authenticated role
-- Needed for CLI user client to update server status after Hetzner provisioning
GRANT EXECUTE ON FUNCTION public.update_sandbox_status(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO authenticated;
