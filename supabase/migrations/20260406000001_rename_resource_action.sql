-- Story 1: rename_resource RPC + action_types registration
-- 1. Create rename_resource() RPC — renames any resource by UUID, rejects user and access-code types
-- 2. Insert action_types entry for rename_resource

-- ── 1. rename_resource() RPC ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.rename_resource(uuid, text);
CREATE OR REPLACE FUNCTION public.rename_resource(p_resource_id UUID, p_new_name TEXT)
RETURNS TABLE(resource_id UUID, old_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_old_name TEXT;
  v_type     TEXT;
BEGIN
  -- Look up resource
  SELECT name, type INTO v_old_name, v_type
  FROM public.resources
  WHERE id = p_resource_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Hard-reject immutable types
  IF v_type IN ('user', 'access-code') THEN
    RAISE EXCEPTION 'Resource type "%" cannot be renamed', v_type
      USING ERRCODE = '22023';
  END IF;

  -- Validate name pattern: alphanumeric, slash, underscore, hyphen; 1-128 chars
  IF p_new_name !~ '^[a-zA-Z0-9/_-]{1,128}$' THEN
    RAISE EXCEPTION 'Invalid resource name: must match ^[a-zA-Z0-9/_-]{1,128}$'
      USING ERRCODE = '22023';
  END IF;

  -- Perform the rename
  UPDATE public.resources
  SET name = p_new_name, updated_at = now()
  WHERE id = p_resource_id;

  RETURN QUERY SELECT p_resource_id, v_old_name;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_resource(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_resource(UUID, TEXT) TO service_role;

-- ── 2. action_types seed data ─────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'rename_resource',
    'rename_resource',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "newName"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" },
        "newName":    { "type": "string", "pattern": "^[a-zA-Z0-9/_-]{1,128}$" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["resourceId", "oldName"],
      "properties": {
        "resourceId": { "type": "string" },
        "oldName":    { "type": "string" }
      }
    }'::jsonb,
    '{"resourceId": "p_resource_id", "newName": "p_new_name"}'::jsonb,
    '{"resource_id": "resourceId", "old_name": "oldName"}'::jsonb,
    'Renames any resource by UUID. Rejects user and access-code types. Validates name against ^[a-zA-Z0-9/_-]{1,128}$.',
    'null'::jsonb
  )
ON CONFLICT (name) DO UPDATE SET
  rpc_function     = EXCLUDED.rpc_function,
  input_schema     = EXCLUDED.input_schema,
  output_schema    = EXCLUDED.output_schema,
  param_mapping    = EXCLUDED.param_mapping,
  result_mapping   = EXCLUDED.result_mapping,
  description      = EXCLUDED.description,
  validation_rules = EXCLUDED.validation_rules;
