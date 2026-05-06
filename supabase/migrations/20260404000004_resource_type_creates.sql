-- Story 4: Resource Type Creates RPCs + action_types entries
-- 1. create_identity() RPC — validates handle and inserts identity resource + partOf link
-- 2. create_app() RPC — inserts app resource + partOf link
-- 3. create_credential() RPC — validates dopplerProject and inserts credential resource + partOf link
-- 4. create_server() RPC — inserts server resource + partOf link
-- 5. action_types rows for all four actions

-- ── 1. create_identity() RPC ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_identity(text, uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_identity(
  p_name       TEXT,
  p_project_id UUID,
  p_handle     TEXT,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(identity_resource_id UUID)
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

  -- Validate handle is non-empty
  IF p_handle IS NULL OR trim(p_handle) = '' THEN
    RAISE EXCEPTION 'handle must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  -- Store handle in config
  v_config := p_config || jsonb_build_object('handle', p_handle);

  -- Insert the identity resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'identity', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the identity to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_identity(TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_identity(TEXT, UUID, TEXT, JSONB) TO service_role;

-- ── 2. create_app() RPC ────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_app(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_app(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(app_resource_id UUID)
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

  -- Config accepts any JSONB, no special validation
  v_config := p_config;

  -- Insert the app resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'app', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the app to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_app(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_app(TEXT, UUID, JSONB) TO service_role;

-- ── 3. create_credential() RPC ─────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_credential(text, uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_credential(
  p_name            TEXT,
  p_project_id      UUID,
  p_doppler_project TEXT,
  p_config          JSONB DEFAULT '{}'
)
RETURNS TABLE(credential_resource_id UUID)
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

  -- Validate dopplerProject is non-empty
  IF p_doppler_project IS NULL OR trim(p_doppler_project) = '' THEN
    RAISE EXCEPTION 'dopplerProject must be non-empty'
      USING ERRCODE = '22023';
  END IF;

  -- Store dopplerProject in config
  v_config := p_config || jsonb_build_object('dopplerProject', p_doppler_project);

  -- Insert the credential resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'credential', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the credential to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_credential(TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credential(TEXT, UUID, TEXT, JSONB) TO service_role;

-- ── 4. create_server() RPC ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_server(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_server(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(server_resource_id UUID)
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

  -- Config accepts any JSONB, no special validation
  v_config := p_config;

  -- Insert the server resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'server', 'active', v_config)
  RETURNING id INTO v_id;

  -- Link the server to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_server(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_server(TEXT, UUID, JSONB) TO service_role;

-- ── 5. action_types seed data ──────────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_identity',
    'create_identity',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId", "handle"],
      "properties": {
        "name":      { "type": "string" },
        "projectId": { "type": "string", "format": "uuid" },
        "handle":    { "type": "string", "minLength": 1 },
        "config":    { "type": "object" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["identityResourceId"],
      "properties": {
        "identityResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "handle": "p_handle", "config": "p_config"}'::jsonb,
    '{"identity_resource_id": "identityResourceId"}'::jsonb,
    'Creates a new identity resource (platform account/handle) linked to a project',
    'null'::jsonb
  ),
  (
    'create_app',
    'create_app',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId"],
      "properties": {
        "name":      { "type": "string" },
        "projectId": { "type": "string", "format": "uuid" },
        "config": {
          "type": "object",
          "properties": {
            "urls": { "type": "array", "items": { "type": "string" } }
          }
        }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["appResourceId"],
      "properties": {
        "appResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "config": "p_config"}'::jsonb,
    '{"app_resource_id": "appResourceId"}'::jsonb,
    'Creates a new app resource linked to a project',
    'null'::jsonb
  ),
  (
    'create_credential',
    'create_credential',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "projectId", "dopplerProject"],
      "properties": {
        "name":           { "type": "string" },
        "projectId":      { "type": "string", "format": "uuid" },
        "dopplerProject": { "type": "string", "minLength": 1 },
        "config":         { "type": "object" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["credentialResourceId"],
      "properties": {
        "credentialResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "dopplerProject": "p_doppler_project", "config": "p_config"}'::jsonb,
    '{"credential_resource_id": "credentialResourceId"}'::jsonb,
    'Creates a new credential resource linked to a project',
    'null'::jsonb
  ),
  (
    'create_server',
    'create_server',
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
      "required": ["serverResourceId"],
      "properties": {
        "serverResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "projectId": "p_project_id", "config": "p_config"}'::jsonb,
    '{"server_resource_id": "serverResourceId"}'::jsonb,
    'Creates a new server resource linked to a project',
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
