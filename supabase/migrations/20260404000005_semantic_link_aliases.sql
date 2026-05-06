-- Story 5: Semantic Link Alias RPCs + action_types entries
-- 1. assign_credential() RPC — wraps create_link with hardcoded link_type='credential'
-- 2. assign_proxy() RPC — wraps create_link with hardcoded link_type='proxy'
-- 3. add_project_member() RPC — validates user/project types then wraps create_link with link_type='member_of'
-- 4. action_types rows for all three actions

-- ── 1. assign_credential() RPC ─────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assign_credential(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_credential(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_created BOOLEAN;
BEGIN
  SELECT cl.created INTO v_created FROM public.create_link(p_from_id, p_to_id, 'credential') AS cl;
  RETURN QUERY SELECT v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_credential(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_credential(UUID, UUID) TO service_role;

-- ── 2. assign_proxy() RPC ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assign_proxy(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_proxy(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_created BOOLEAN;
BEGIN
  SELECT cl.created INTO v_created FROM public.create_link(p_from_id, p_to_id, 'proxy') AS cl;
  RETURN QUERY SELECT v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_proxy(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_proxy(UUID, UUID) TO service_role;

-- ── 3. add_project_member() RPC ────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.add_project_member(uuid, uuid);
CREATE OR REPLACE FUNCTION public.add_project_member(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_created   BOOLEAN;
  v_from_type TEXT;
  v_to_type   TEXT;
BEGIN
  -- Validate from resource exists and is type=user
  SELECT type INTO v_from_type FROM public.resources WHERE id = p_from_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User resource not found: %', p_from_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_from_type != 'user' THEN
    RAISE EXCEPTION 'add_project_member requires from resource to be type=user, got %', v_from_type
      USING ERRCODE = '22023';
  END IF;

  -- Validate to resource exists and is type=project
  SELECT type INTO v_to_type FROM public.resources WHERE id = p_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project resource not found: %', p_to_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_to_type != 'project' THEN
    RAISE EXCEPTION 'add_project_member requires to resource to be type=project, got %', v_to_type
      USING ERRCODE = '22023';
  END IF;

  SELECT cl.created INTO v_created FROM public.create_link(p_from_id, p_to_id, 'member_of') AS cl;
  RETURN QUERY SELECT v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.add_project_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_project_member(UUID, UUID) TO service_role;

-- ── 4. action_types seed data ──────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'assign_credential',
    'assign_credential',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "credentialId"],
      "properties": {
        "resourceId":   { "type": "string", "format": "uuid" },
        "credentialId": { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["created"],
      "properties": {
        "created": { "type": "boolean" }
      }
    }'::jsonb,
    '{"resourceId": "p_from_id", "credentialId": "p_to_id"}'::jsonb,
    '{"created": "created"}'::jsonb,
    'Assigns a credential resource to an identity resource (max 1)',
    'null'::jsonb
  ),
  (
    'assign_proxy',
    'assign_proxy',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "proxyId"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" },
        "proxyId":    { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["created"],
      "properties": {
        "created": { "type": "boolean" }
      }
    }'::jsonb,
    '{"resourceId": "p_from_id", "proxyId": "p_to_id"}'::jsonb,
    '{"created": "created"}'::jsonb,
    'Assigns a proxy resource to an identity resource (max 1)',
    'null'::jsonb
  ),
  (
    'add_project_member',
    'add_project_member',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["userId", "projectId"],
      "properties": {
        "userId":    { "type": "string", "format": "uuid" },
        "projectId": { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["created"],
      "properties": {
        "created": { "type": "boolean" }
      }
    }'::jsonb,
    '{"userId": "p_from_id", "projectId": "p_to_id"}'::jsonb,
    '{"created": "created"}'::jsonb,
    'Adds a user as a member of a project',
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
