-- Story 1: Process Lifecycle RPCs + action_types entries
-- 1. init_process()      — creates a process row and writes an audit action_event
-- 2. fetch_skill_content() — retrieves config.content from a skill resource
-- 3. fail_process()      — marks a process as failed

-- ── 1. init_process() RPC ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.init_process(text, text, text, text, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.init_process(
  p_name               TEXT,
  p_branch             TEXT    DEFAULT NULL,
  p_run_type           TEXT    DEFAULT 'local',
  p_worktree_path      TEXT    DEFAULT NULL,
  p_skill_resource_id  UUID    DEFAULT NULL,
  p_parent_process_id  UUID    DEFAULT NULL,
  p_project_id         UUID    DEFAULT NULL
)
RETURNS TABLE(process_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
  v_root_id UUID;
BEGIN
  -- Pre-generate UUID so root_process_id can self-reference for root processes
  v_id := gen_random_uuid();

  -- Inherit parent's root_process_id if available, otherwise this process is its own root
  IF p_parent_process_id IS NOT NULL THEN
    SELECT root_process_id INTO v_root_id
    FROM public.processes
    WHERE id = p_parent_process_id;
  END IF;
  v_root_id := COALESCE(v_root_id, v_id);

  INSERT INTO public.processes (
    id,
    name,
    branch,
    run_type,
    worktree_path,
    skill_resource_id,
    parent_campaign_id,
    project_id,
    status,
    root_process_id
  ) VALUES (
    v_id,
    p_name,
    p_branch,
    p_run_type,
    p_worktree_path,
    p_skill_resource_id,
    p_parent_process_id,
    p_project_id,
    'pending',
    v_root_id
  );

  INSERT INTO public.action_events (action_type, input, output, status)
  VALUES (
    'init_process',
    jsonb_build_object(
      'name',              p_name,
      'branch',            p_branch,
      'runType',           p_run_type,
      'worktreePath',      p_worktree_path,
      'skillResourceId',   p_skill_resource_id,
      'parentProcessId',   p_parent_process_id,
      'projectId',         p_project_id
    ),
    jsonb_build_object('process_id', v_id),
    'success'
  );

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.init_process(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.init_process(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID) TO service_role;

-- ── 2. fetch_skill_content() RPC ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fetch_skill_content(uuid);
CREATE OR REPLACE FUNCTION public.fetch_skill_content(
  p_skill_resource_id UUID
)
RETURNS TABLE(content TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_skill_resource_id) THEN
    RAISE EXCEPTION 'Skill resource not found: %', p_skill_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
    SELECT config->>'content' AS content
    FROM public.resources
    WHERE id = p_skill_resource_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fetch_skill_content(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fetch_skill_content(UUID) TO service_role;

-- ── 3. fail_process() RPC ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.fail_process(uuid, text);
CREATE OR REPLACE FUNCTION public.fail_process(
  p_process_id UUID,
  p_reason     TEXT DEFAULT NULL
)
RETURNS TABLE(process_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  UPDATE public.processes
  SET status = 'failed', updated_at = NOW()
  WHERE id = p_process_id
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_process(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_process(UUID, TEXT) TO service_role;

-- ── 4. action_types seed data ──────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'init_process',
    'init_process',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name"],
      "properties": {
        "name":             { "type": "string", "minLength": 1 },
        "branch":           { "type": "string" },
        "runType":          { "type": "string" },
        "worktreePath":     { "type": "string" },
        "skillResourceId":  { "type": "string", "format": "uuid" },
        "parentProcessId":  { "type": "string", "format": "uuid" },
        "projectId":        { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["processId"],
      "properties": {
        "processId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "branch": "p_branch", "runType": "p_run_type", "worktreePath": "p_worktree_path", "skillResourceId": "p_skill_resource_id", "parentProcessId": "p_parent_process_id", "projectId": "p_project_id"}'::jsonb,
    '{"process_id": "processId"}'::jsonb,
    'Creates a new process row in pending status and writes an audit action_event entry',
    'null'::jsonb
  ),
  (
    'fetch_skill_content',
    'fetch_skill_content',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["skillResourceId"],
      "properties": {
        "skillResourceId": { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["content"],
      "properties": {
        "content": { "type": "string" }
      }
    }'::jsonb,
    '{"skillResourceId": "p_skill_resource_id"}'::jsonb,
    '{"content": "content"}'::jsonb,
    'Retrieves config.content from a skill resource by its UUID',
    'null'::jsonb
  ),
  (
    'fail_process',
    'fail_process',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["processId"],
      "properties": {
        "processId": { "type": "string", "format": "uuid" },
        "reason":    { "type": "string" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["processId"],
      "properties": {
        "processId": { "type": "string" }
      }
    }'::jsonb,
    '{"processId": "p_process_id", "reason": "p_reason"}'::jsonb,
    '{"process_id": "processId"}'::jsonb,
    'Marks a process as failed and updates its updated_at timestamp',
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
