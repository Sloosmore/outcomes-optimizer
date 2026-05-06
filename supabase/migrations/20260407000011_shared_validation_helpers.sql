-- Story 2: Shared PL/pgSQL validation helper functions
-- These helpers are called by other SECURITY DEFINER functions to centralise
-- common validation logic without duplicating it across every RPC.

-- ── 1. validate_resource_name(p_name text) ──────────────────────────────────
-- Raises an exception whose message contains 'invalid' when the supplied name
-- does not match the allowed character set.  Callers can rely on that keyword.
DROP FUNCTION IF EXISTS public.validate_resource_name(text);
CREATE OR REPLACE FUNCTION public.validate_resource_name(
  p_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF p_name IS NULL OR p_name !~ '^[a-zA-Z0-9/_-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid resource name "%": must match ^[a-zA-Z0-9/_-]{1,128}$', p_name
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_resource_name(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_resource_name(TEXT) TO service_role;

-- ── 2. validate_link_type_pairing(p_from_type, p_to_type, p_link_type) ──────
-- Raises an exception when the (from_type, to_type, link_type) triple has no
-- matching row in link_type_rules.  The message references 'link_type_rules'
-- so callers can grep for either 'invalid' or 'link_type_rules'.
DROP FUNCTION IF EXISTS public.validate_link_type_pairing(text, text, text);
CREATE OR REPLACE FUNCTION public.validate_link_type_pairing(
  p_from_type TEXT,
  p_to_type   TEXT,
  p_link_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.link_type_rules
    WHERE link_type = p_link_type
      AND (from_type = p_from_type OR from_type IS NULL)
      AND (to_type   = p_to_type   OR to_type   IS NULL)
  ) THEN
    RAISE EXCEPTION 'invalid link_type_rules pairing: from_type=%, to_type=%, link_type=%',
      p_from_type, p_to_type, p_link_type
      USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_link_type_pairing(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_link_type_pairing(TEXT, TEXT, TEXT) TO service_role;
