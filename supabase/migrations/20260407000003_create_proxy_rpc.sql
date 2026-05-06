-- Story 3: create_proxy RPC + action_types entry
-- Reads resource_type_properties to validate and apply defaults dynamically

-- ── 1. create_proxy() RPC ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_proxy(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_proxy(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(proxy_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id      UUID;
  v_config  JSONB;
  v_field   TEXT;
  v_req     BOOLEAN;
  v_default JSONB;
  r         RECORD;
BEGIN
  -- Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  v_config := p_config;

  -- Loop over resource_type_properties for 'proxy' to validate required fields
  -- and fill optional fields from defaults
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'proxy'
  LOOP
    v_field   := r.field_name;
    v_req     := r.required;
    v_default := r.default_value;

    IF v_req = true AND (v_config -> v_field) IS NULL THEN
      RAISE EXCEPTION 'Required field "%" is missing for resource type "proxy"', v_field
        USING ERRCODE = '22023';
    END IF;

    IF v_req = false AND (v_config -> v_field) IS NULL AND v_default IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[v_field], v_default, true);
    END IF;
  END LOOP;

  -- Insert the proxy resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'proxy', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the proxy to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_proxy(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_proxy(TEXT, UUID, JSONB) TO service_role;

-- ── 2. action_types entry ──────────────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_proxy',
    'create_proxy',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId"],
      "properties": {
        "name":      { "type": "string" },
        "projectId": { "type": "string", "format": "uuid" },
        "config":    { "type": "object" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["proxyResourceId"],
      "properties": {
        "proxyResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "config": "p_config"}'::jsonb,
    '{"proxy_resource_id": "proxyResourceId"}'::jsonb,
    'Creates a new proxy resource with property-system validation, linked to a project',
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
