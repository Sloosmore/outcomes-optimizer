-- Story 8: Add assign_parent RPC and register it in action_types.
-- Creates a parent link between two resources (identity→app, server→app, etc.)

-- ── 1. assign_parent() RPC ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assign_parent(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_parent(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
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

  -- Validate link type pairing (raises exception if invalid)
  PERFORM public.validate_link_type_pairing(v_from_type, v_to_type, 'parent');

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'parent'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'parent');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_parent(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_parent(UUID, UUID) TO service_role;

-- ── 2. Register assign_parent in action_types ──────────────────────────────
INSERT INTO public.action_types (
  name,
  rpc_function,
  input_schema,
  output_schema,
  param_mapping,
  result_mapping,
  description
) VALUES (
  'assign_parent',
  'assign_parent',
  '{"$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "required": ["fromId", "toId"], "properties": {"fromId": {"type": "string", "format": "uuid"}, "toId": {"type": "string", "format": "uuid"}}, "additionalProperties": false}'::jsonb,
  '{"type": "object", "required": ["created"], "properties": {"created": {"type": "boolean"}}}'::jsonb,
  '{"fromId": "p_from_id", "toId": "p_to_id"}'::jsonb,
  '{"created": "created"}'::jsonb,
  'Creates a parent link between two resources (identity→app, server→app, etc.)'
)
ON CONFLICT (name) DO UPDATE SET
  rpc_function = EXCLUDED.rpc_function,
  input_schema = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description = EXCLUDED.description;
