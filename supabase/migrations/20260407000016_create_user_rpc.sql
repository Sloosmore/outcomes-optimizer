-- Story 10: Add create_user RPC with validate_resource_name (10th typed create function)
-- Criterion 7 requires create_user to use validate_resource_name, completing the set of
-- 10 typed create RPCs: agent, proxy, skill, identity, app, credential, server, cron, project, user

-- ── 0. Register create_user action type ───────────────────────────────────────
INSERT INTO public.action_types (
  name,
  rpc_function,
  input_schema,
  output_schema,
  param_mapping,
  result_mapping,
  description
)
VALUES (
  'create_user',
  'create_user',
  '{"type":"object","required":["p_name","p_project_id"],"properties":{"p_name":{"type":"string"},"p_project_id":{"type":"string","format":"uuid"},"p_config":{"type":"object"}}}'::jsonb,
  '{"type":"object","properties":{"user_resource_id":{"type":"string","format":"uuid"}}}'::jsonb,
  '{"p_name":"name","p_project_id":"project_id","p_config":"config"}'::jsonb,
  '{"user_resource_id":"id"}'::jsonb,
  'Create a user resource linked to a project, validating name and config schema'
)
ON CONFLICT (name) DO NOTHING;

-- ── 1. create_user() ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_user(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_user(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(user_resource_id UUID)
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  v_config := p_config;

  -- Loop over resource_type_properties for 'user' to validate required fields
  -- and fill optional fields from defaults
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'user'
  LOOP
    v_field   := r.field_name;
    v_req     := r.required;
    v_default := r.default_value;

    IF v_req = true AND (v_config -> v_field) IS NULL THEN
      RAISE EXCEPTION 'Required field "%" is missing for resource type "user"', v_field
        USING ERRCODE = '22023';
    END IF;

    IF v_req = false AND (v_config -> v_field) IS NULL AND v_default IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[v_field], v_default, true);
    END IF;
  END LOOP;

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('user', 'project', 'partOf');

  -- 4. Upsert the user resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'user', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the user to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  -- 6. Log to action_events
  INSERT INTO public.action_events (action_type, input, output, status, target_resource_id)
  VALUES (
    'create_user',
    jsonb_build_object('p_name', p_name, 'p_project_id', p_project_id),
    jsonb_build_object('user_resource_id', v_id),
    'success',
    v_id
  );

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_user(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_user(TEXT, UUID, JSONB) TO service_role;
