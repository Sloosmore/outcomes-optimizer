-- Migration: update update_sandbox_status() to preserve hetzner_server_id when empty string is passed
-- When the bootstrap script calls /sandbox/ready, it doesn't know its own Hetzner server ID,
-- so it sends an empty string. We should preserve the existing value in that case.

CREATE OR REPLACE FUNCTION public.update_sandbox_status(
  p_server_resource_id UUID,
  p_status TEXT,
  p_ip TEXT,
  p_hetzner_server_id TEXT,
  p_provisioned_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing_hetzner_id TEXT;
BEGIN
  -- Preserve existing hetzner_server_id if the incoming value is an empty string
  SELECT config->>'hetzner_server_id'
    INTO v_existing_hetzner_id
  FROM public.resources
  WHERE id = p_server_resource_id;

  UPDATE public.resources
  SET
    config = config || jsonb_build_object(
      'status', p_status,
      'ip', p_ip,
      'hetzner_server_id', COALESCE(NULLIF(p_hetzner_server_id, ''), v_existing_hetzner_id, ''),
      'provisioned_at', p_provisioned_at
    ),
    updated_at = now()
  WHERE id = p_server_resource_id;
END;
$$;

-- Revoke execute from PUBLIC, grant explicitly to service_role
REVOKE ALL ON FUNCTION public.update_sandbox_status(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sandbox_status(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
