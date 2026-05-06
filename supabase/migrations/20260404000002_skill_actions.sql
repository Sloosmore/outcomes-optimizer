-- Story 2: Skill Lifecycle RPCs + action_types entries
-- 1. create_skill() RPC — validates config and inserts skill resource + partOf link
-- 2. update_skill_config() RPC — merges config with formula XOR metric validation
-- 3. update_skill_content() RPC — updates config.content with content validation
-- 4. action_types rows for all 3 actions

-- ── 1. create_skill() RPC ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_skill(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB
)
RETURNS TABLE(skill_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate required config fields: prompt (non-empty string)
  IF p_config->>'prompt' IS NULL OR trim(p_config->>'prompt') = '' THEN
    RAISE EXCEPTION 'config.prompt is required and must be a non-empty string'
      USING ERRCODE = '22023';
  END IF;

  -- Validate required config fields: epochs (integer >= 1)
  IF p_config->'epochs' IS NULL THEN
    RAISE EXCEPTION 'config.epochs is required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_config->'epochs') <> 'number' OR (p_config->>'epochs')::integer < 1 THEN
    RAISE EXCEPTION 'config.epochs must be an integer >= 1'
      USING ERRCODE = '22023';
  END IF;

  -- Validate required config fields: worktree (boolean)
  IF p_config->'worktree' IS NULL OR jsonb_typeof(p_config->'worktree') <> 'boolean' THEN
    RAISE EXCEPTION 'config.worktree is required and must be a boolean'
      USING ERRCODE = '22023';
  END IF;

  -- Validate required config fields: git (boolean)
  IF p_config->'git' IS NULL OR jsonb_typeof(p_config->'git') <> 'boolean' THEN
    RAISE EXCEPTION 'config.git is required and must be a boolean'
      USING ERRCODE = '22023';
  END IF;

  -- Validate required config fields: pr (boolean)
  IF p_config->'pr' IS NULL OR jsonb_typeof(p_config->'pr') <> 'boolean' THEN
    RAISE EXCEPTION 'config.pr is required and must be a boolean'
      USING ERRCODE = '22023';
  END IF;

  -- Validate required config fields: content (string)
  IF p_config->>'content' IS NULL THEN
    RAISE EXCEPTION 'config.content is required and must be a string'
      USING ERRCODE = '22023';
  END IF;

  -- Validate content length > 100 chars
  IF length(p_config->>'content') <= 100 THEN
    RAISE EXCEPTION 'config.content must be longer than 100 characters'
      USING ERRCODE = '22023';
  END IF;

  -- Validate content must NOT contain '/skills/', 'SKILL.md', or 'workspace/'
  IF p_config->>'content' LIKE '%/skills/%' OR
     p_config->>'content' LIKE '%SKILL.md%' OR
     p_config->>'content' LIKE '%workspace/%' THEN
    RAISE EXCEPTION 'config.content must not contain /skills/, SKILL.md, or workspace/'
      USING ERRCODE = '22023';
  END IF;

  -- Validate formula XOR metric: both cannot be non-null simultaneously
  IF p_config->'formula' IS NOT NULL AND p_config->'formula' <> 'null'::jsonb AND
     p_config->'metric'  IS NOT NULL AND p_config->'metric'  <> 'null'::jsonb THEN
    RAISE EXCEPTION 'config.formula and config.metric are mutually exclusive — provide one or neither, not both'
      USING ERRCODE = '22023';
  END IF;

  -- Validate metric pattern if present: must match ^[a-z][a-z0-9_-]*$
  IF p_config->'metric' IS NOT NULL AND p_config->'metric' <> 'null'::jsonb THEN
    IF p_config->>'metric' !~ '^[a-z][a-z0-9_-]*$' THEN
      RAISE EXCEPTION 'config.metric must match pattern ^[a-z][a-z0-9_-]*$'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Insert the skill resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'skill', 'active', p_config)
  RETURNING id INTO v_id;

  -- Link the skill to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_skill(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_skill(TEXT, UUID, JSONB) TO service_role;

-- ── 2. update_skill_config() RPC ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_skill_config(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.update_skill_config(
  p_resource_id UUID,
  p_config      JSONB
)
RETURNS TABLE(resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing_config JSONB;
  v_merged          JSONB;
BEGIN
  -- Validate resource exists with type='skill'
  SELECT config INTO v_existing_config
  FROM public.resources
  WHERE id = p_resource_id AND type = 'skill';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Skill resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Merge config: existing first, then override with new
  v_merged := v_existing_config || p_config;

  -- Re-validate formula XOR metric on merged result
  IF v_merged->'formula' IS NOT NULL AND v_merged->'formula' <> 'null'::jsonb AND
     v_merged->'metric'  IS NOT NULL AND v_merged->'metric'  <> 'null'::jsonb THEN
    RAISE EXCEPTION 'config.formula and config.metric are mutually exclusive — provide one or neither, not both'
      USING ERRCODE = '22023';
  END IF;

  -- Update the resource config
  UPDATE public.resources
  SET config = v_merged, updated_at = now()
  WHERE id = p_resource_id;

  RETURN QUERY SELECT p_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_skill_config(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_skill_config(UUID, JSONB) TO service_role;

-- ── 3. update_skill_content() RPC ─────────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_skill_content(uuid, text);
CREATE OR REPLACE FUNCTION public.update_skill_content(
  p_resource_id UUID,
  p_content     TEXT
)
RETURNS TABLE(resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Validate resource exists with type='skill'
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_resource_id AND type = 'skill'
  ) THEN
    RAISE EXCEPTION 'Skill resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate content length > 100 chars
  IF length(p_content) <= 100 THEN
    RAISE EXCEPTION 'content must be longer than 100 characters'
      USING ERRCODE = '22023';
  END IF;

  -- Validate content must NOT contain '/skills/', 'SKILL.md', or 'workspace/'
  IF p_content LIKE '%/skills/%' OR
     p_content LIKE '%SKILL.md%' OR
     p_content LIKE '%workspace/%' THEN
    RAISE EXCEPTION 'content must not contain /skills/, SKILL.md, or workspace/'
      USING ERRCODE = '22023';
  END IF;

  -- Update only the content field within config
  UPDATE public.resources
  SET config = jsonb_set(config, '{content}', to_jsonb(p_content)), updated_at = now()
  WHERE id = p_resource_id;

  RETURN QUERY SELECT p_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_skill_content(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_skill_content(UUID, TEXT) TO service_role;

-- ── 4. action_types seed data ──────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_skill',
    'create_skill',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId", "config"],
      "properties": {
        "name":      { "type": "string", "minLength": 1 },
        "projectId": { "type": "string", "format": "uuid" },
        "config":    { "type": "object" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["skillResourceId"],
      "properties": {
        "skillResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "config": "p_config"}'::jsonb,
    '{"skill_resource_id": "skillResourceId"}'::jsonb,
    'Creates a new skill resource with validated config and links it to the specified project',
    'null'::jsonb
  ),
  (
    'update_skill_config',
    'update_skill_config',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "config"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" },
        "config":     { "type": "object" }
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
    '{"resourceId": "p_resource_id", "config": "p_config"}'::jsonb,
    '{"resource_id": "resourceId"}'::jsonb,
    'Merges the provided config into an existing skill resource config, with formula XOR metric validation on the merged result',
    'null'::jsonb
  ),
  (
    'update_skill_content',
    'update_skill_content',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "content"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" },
        "content":    { "type": "string", "minLength": 101 }
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
    '{"resourceId": "p_resource_id", "content": "p_content"}'::jsonb,
    '{"resource_id": "resourceId"}'::jsonb,
    'Updates the content field within a skill resource config; validates length and prohibited path patterns',
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
