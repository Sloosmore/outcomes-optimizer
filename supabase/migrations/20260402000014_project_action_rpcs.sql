-- Story 2: Create create_project and rename_project Postgres RPCs + action_types entries
-- 1. Create create_project() RPC — idempotent: returns existing project UUID if name taken
-- 2. Create rename_project() RPC — fails if new name is already in use by another project
-- 3. Insert action_types entries for both RPCs

-- ── 1. create_project() RPC ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_project(text);
CREATE OR REPLACE FUNCTION public.create_project(p_name TEXT)
RETURNS TABLE(project_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  -- Idempotent: return existing project if name is taken
  SELECT id INTO v_id FROM public.resources WHERE name = p_name AND type = 'project';
  IF v_id IS NULL THEN
    INSERT INTO public.resources (id, name, type, status)
    VALUES (gen_random_uuid(), p_name, 'project', 'active')
    RETURNING id INTO v_id;
  END IF;
  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project(TEXT) TO service_role;

-- ── 2. rename_project() RPC ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.rename_project(uuid, text);
CREATE OR REPLACE FUNCTION public.rename_project(p_project_resource_id UUID, p_new_name TEXT)
RETURNS TABLE(project_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Enforce global uniqueness (excluding the project being renamed)
  IF EXISTS (
    SELECT 1 FROM public.resources
    WHERE name = p_new_name AND type = 'project' AND id <> p_project_resource_id
  ) THEN
    RAISE EXCEPTION 'A project with this name already exists'
      USING ERRCODE = '23505';
  END IF;

  UPDATE public.resources
  SET name = p_new_name, updated_at = now()
  WHERE id = p_project_resource_id AND type = 'project';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found: %', p_project_resource_id
      USING ERRCODE = '42704';
  END IF;

  RETURN QUERY SELECT p_project_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_project(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_project(UUID, TEXT) TO service_role;

-- ── 3. action_types seed data ─────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_project',
    'create_project',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["projectResourceId"],
      "properties": {
        "projectResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name"}'::jsonb,
    '{"project_resource_id": "projectResourceId"}'::jsonb,
    'Creates a new project resource, or returns the existing one if the name is already taken',
    '{
      "uniqueness": [
        {
          "table": "resources",
          "where": { "type": "project" },
          "field": "name",
          "input_field": "name",
          "error": "A project with this name already exists",
          "on_conflict": "return_existing",
          "result_mapping": { "id": "projectResourceId" }
        }
      ]
    }'::jsonb
  ),
  (
    'rename_project',
    'rename_project',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["projectResourceId", "newName"],
      "properties": {
        "projectResourceId": { "type": "string" },
        "newName": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["projectResourceId"],
      "properties": {
        "projectResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"projectResourceId": "p_project_resource_id", "newName": "p_new_name"}'::jsonb,
    '{"project_resource_id": "projectResourceId"}'::jsonb,
    'Renames an existing project resource; fails if the new name is already in use by another project',
    '{
      "uniqueness": [
        {
          "table": "resources",
          "where": { "type": "project" },
          "field": "name",
          "input_field": "newName",
          "error": "A project with this name already exists",
          "on_conflict": "error"
        }
      ]
    }'::jsonb
  )
ON CONFLICT (name) DO UPDATE SET
  rpc_function   = EXCLUDED.rpc_function,
  input_schema   = EXCLUDED.input_schema,
  output_schema  = EXCLUDED.output_schema,
  param_mapping  = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description    = EXCLUDED.description,
  validation_rules = EXCLUDED.validation_rules;
