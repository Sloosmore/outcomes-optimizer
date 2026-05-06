-- Fix assign_proxy to call validate_link_type_pairing before INSERT.
-- Migration 000020 fixed assign_credential with the same pattern but assign_proxy
-- was not updated. This makes assign_proxy consistent: it now looks up from_type
-- and to_type from resources and delegates to validate_link_type_pairing before
-- any INSERT, preventing invalid link pairings from bypassing link_type_rules.

-- ── 1. assign_proxy(uuid, uuid) — with validate_link_type_pairing ─────────────
DROP FUNCTION IF EXISTS public.assign_proxy(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_proxy(p_from_id uuid, p_to_id uuid)
RETURNS TABLE(created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_from_type TEXT;
  v_to_type   TEXT;
BEGIN
  -- Validate from resource exists (FOR UPDATE serializes concurrent link creations)
  SELECT type INTO v_from_type FROM public.resources WHERE id = p_from_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'From resource not found: %', p_from_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate to resource exists
  SELECT type INTO v_to_type FROM public.resources WHERE id = p_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'To resource not found: %', p_to_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate link_type_rules pairing before INSERT.
  PERFORM public.validate_link_type_pairing(v_from_type, v_to_type, 'proxy');

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'proxy'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'proxy');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_proxy(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_proxy(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_proxy(UUID, UUID) TO service_role;
