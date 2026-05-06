-- Story 16: Fix assign_credential to call validate_link_type_pairing before INSERT.
-- The previous implementation inserted the credential link directly without checking
-- link_type_rules, allowing invalid pairings (e.g., user→user) to be silently accepted.
-- This migration rewrites assign_credential(uuid,uuid) to look up from_type and to_type
-- from the resources table and then delegates to validate_link_type_pairing before INSERT.
-- A text overload assign_credential(text,text) is added for criterion proof commands
-- which cast UUIDs to ::text before calling the function.

-- ── 1. assign_credential(uuid, uuid) — with validate_link_type_pairing ────────
DROP FUNCTION IF EXISTS public.assign_credential(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_credential(p_from_id uuid, p_to_id uuid)
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
  -- Internally calls: SELECT 1 FROM public.link_type_rules WHERE link_type = 'credential' ...
  PERFORM public.validate_link_type_pairing(v_from_type, v_to_type, 'credential');

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'credential'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'credential');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_credential(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_credential(UUID, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_credential(UUID, UUID) TO service_role;

-- ── 2. assign_credential(text, text) — text overload ─────────────────────────
-- Criterion proof commands cast resource IDs to ::text before calling the function.
-- This overload converts the text arguments to uuid and delegates to the uuid version.
DROP FUNCTION IF EXISTS public.assign_credential(text, text);
CREATE OR REPLACE FUNCTION public.assign_credential(p_from_id text, p_to_id text)
RETURNS TABLE(created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.assign_credential(p_from_id::uuid, p_to_id::uuid);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_credential(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_credential(TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_credential(TEXT, TEXT) TO service_role;
