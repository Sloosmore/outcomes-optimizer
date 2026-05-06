-- Story 3: Cron Lifecycle RPCs + action_types entries
-- 1. create_cron() RPC — validates cron schedule and inserts cron resource + schedules + partOf links
-- 2. update_cron_schedule() RPC — merges non-null fields into cron resource config
-- 3. action_types rows for both actions

-- ── 1. create_cron() RPC ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_cron(text, uuid, uuid, text, boolean, text, text[]);
CREATE OR REPLACE FUNCTION public.create_cron(
  p_name              TEXT,
  p_project_id        UUID,
  p_skill_resource_id UUID,
  p_schedule          TEXT,
  p_enabled           BOOLEAN,
  p_prompt            TEXT DEFAULT NULL,
  p_depends_on        TEXT[] DEFAULT '{}'
)
RETURNS TABLE(cron_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id     UUID;
  v_config JSONB;
BEGIN
  -- Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate p_schedule is a 5-field cron expression
  IF p_schedule !~ '^\S+\s+\S+\s+\S+\s+\S+\s+\S+$' THEN
    RAISE EXCEPTION 'schedule must be a valid 5-field cron expression'
      USING ERRCODE = '22023';
  END IF;

  -- Validate skill resource exists and type='skill'
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_skill_resource_id AND type = 'skill'
  ) THEN
    RAISE EXCEPTION 'Skill resource not found: %', p_skill_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Build config JSONB with required fields
  v_config := jsonb_build_object(
    'schedule', p_schedule,
    'enabled',  p_enabled
  );

  -- Add optional fields if non-null
  IF p_prompt IS NOT NULL THEN
    v_config := v_config || jsonb_build_object('prompt', p_prompt);
  END IF;

  IF p_depends_on IS NOT NULL AND array_length(p_depends_on, 1) > 0 THEN
    v_config := v_config || jsonb_build_object('depends_on', to_jsonb(p_depends_on));
  END IF;

  -- Insert the cron resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'cron', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the cron to its skill via schedules
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_skill_resource_id, 'schedules')
  ON CONFLICT DO NOTHING;

  -- Link the cron to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cron(TEXT, UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cron(TEXT, UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT[]) TO service_role;

-- ── 2. update_cron_schedule() RPC ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_cron_schedule(uuid, text, boolean, text);
CREATE OR REPLACE FUNCTION public.update_cron_schedule(
  p_resource_id UUID,
  p_schedule    TEXT DEFAULT NULL,
  p_enabled     BOOLEAN DEFAULT NULL,
  p_prompt      TEXT DEFAULT NULL
)
RETURNS TABLE(resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_config JSONB;
BEGIN
  -- Validate resource exists and type='cron'
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_resource_id AND type = 'cron'
  ) THEN
    RAISE EXCEPTION 'Cron resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- If p_schedule is provided, validate it is a 5-field cron expression
  IF p_schedule IS NOT NULL AND p_schedule !~ '^\S+\s+\S+\s+\S+\s+\S+\s+\S+$' THEN
    RAISE EXCEPTION 'schedule must be a valid 5-field cron expression'
      USING ERRCODE = '22023';
  END IF;

  -- Load existing config
  SELECT config INTO v_config
  FROM public.resources
  WHERE id = p_resource_id;

  -- Merge only non-null fields
  IF p_schedule IS NOT NULL THEN
    v_config := jsonb_set(v_config, '{schedule}', to_jsonb(p_schedule));
  END IF;

  IF p_enabled IS NOT NULL THEN
    v_config := jsonb_set(v_config, '{enabled}', to_jsonb(p_enabled));
  END IF;

  IF p_prompt IS NOT NULL THEN
    v_config := jsonb_set(v_config, '{prompt}', to_jsonb(p_prompt));
  END IF;

  UPDATE public.resources
  SET config = v_config, updated_at = now()
  WHERE id = p_resource_id;

  RETURN QUERY SELECT p_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_cron_schedule(UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cron_schedule(UUID, TEXT, BOOLEAN, TEXT) TO service_role;

-- ── 3. action_types seed data ──────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_cron',
    'create_cron',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId", "skillResourceId", "schedule", "enabled"],
      "properties": {
        "name":              { "type": "string", "minLength": 1 },
        "projectId":         { "type": "string", "format": "uuid" },
        "skillResourceId":   { "type": "string", "format": "uuid" },
        "schedule":          { "type": "string" },
        "enabled":           { "type": "boolean" },
        "prompt":            { "type": "string" },
        "dependsOn":         { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["cronResourceId"],
      "properties": {
        "cronResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "skillResourceId": "p_skill_resource_id", "schedule": "p_schedule", "enabled": "p_enabled", "prompt": "p_prompt", "dependsOn": "p_depends_on"}'::jsonb,
    '{"cron_resource_id": "cronResourceId"}'::jsonb,
    'Creates a new cron resource linked to a skill for scheduled execution',
    'null'::jsonb
  ),
  (
    'update_cron_schedule',
    'update_cron_schedule',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" },
        "schedule":   { "type": "string" },
        "enabled":    { "type": "boolean" },
        "prompt":     { "type": "string" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["resourceId"],
      "properties": {
        "resourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"resourceId": "p_resource_id", "schedule": "p_schedule", "enabled": "p_enabled", "prompt": "p_prompt"}'::jsonb,
    '{"resource_id": "resourceId"}'::jsonb,
    'Updates schedule, enabled state, or prompt for an existing cron resource',
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
