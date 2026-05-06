-- Story 3: Wire validate_resource_name + validate_link_type_pairing into all create RPCs
-- Also adds ON CONFLICT (name) DO UPDATE upsert to all main resource INSERTs
-- RPCs updated: create_agent, create_proxy, create_skill, create_identity, create_app,
--               create_credential, create_server, create_cron, create_project

-- ── 0. Re-add UNIQUE(name) constraint on resources ────────────────────────────
-- Migration 20260402000013 dropped the global UNIQUE(name) constraint to support
-- user/project resources with auth_user_id-based uniqueness. We restore it here
-- (as a named constraint) so that all typed create RPCs can use ON CONFLICT (name).
-- The validate_resource_name helper already enforces the allowed character set,
-- so name collisions across types (e.g. two resources with same name but different
-- type) should not occur in practice; this constraint prevents them at the DB level.
ALTER TABLE public.resources ADD CONSTRAINT resources_name_unique UNIQUE (name);

-- ── 1. create_agent() ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_agent(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_agent(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(agent_resource_id UUID)
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

  -- Loop over resource_type_properties for 'agent' to validate required fields
  -- and fill optional fields from defaults
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'agent'
  LOOP
    v_field   := r.field_name;
    v_req     := r.required;
    v_default := r.default_value;

    IF v_req = true AND (v_config -> v_field) IS NULL THEN
      RAISE EXCEPTION 'Required field "%" is missing for resource type "agent"', v_field
        USING ERRCODE = '22023';
    END IF;

    IF v_req = false AND (v_config -> v_field) IS NULL AND v_default IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[v_field], v_default, true);
    END IF;
  END LOOP;

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('agent', 'project', 'partOf');

  -- 4. Upsert the agent resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'agent', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the agent to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_agent(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_agent(TEXT, UUID, JSONB) TO service_role;

-- ── 2. create_proxy() ──────────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
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

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('proxy', 'project', 'partOf');

  -- 4. Upsert the proxy resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'proxy', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the proxy to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_proxy(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_proxy(TEXT, UUID, JSONB) TO service_role;

-- ── 3. create_skill() ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_skill(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(
  p_name       TEXT,
  p_project_id UUID,
  p_config     JSONB DEFAULT '{}'
)
RETURNS TABLE(skill_resource_id UUID)
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

  -- Loop over resource_type_properties for 'skill' to validate required fields
  -- and fill optional fields from defaults
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'skill'
  LOOP
    v_field   := r.field_name;
    v_req     := r.required;
    v_default := r.default_value;

    IF v_req = true AND (v_config -> v_field) IS NULL THEN
      RAISE EXCEPTION 'Required field "%" is missing for resource type "skill"', v_field
        USING ERRCODE = '22023';
    END IF;

    IF v_req = false AND (v_config -> v_field) IS NULL AND v_default IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[v_field], v_default, true);
    END IF;
  END LOOP;

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('skill', 'project', 'partOf');

  -- 4. Upsert the skill resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'skill', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the skill to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_skill(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_skill(TEXT, UUID, JSONB) TO service_role;

-- ── 4. create_identity() ───────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
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

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('identity', 'project', 'partOf');

  -- 4. Upsert the identity resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'identity', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the identity to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_identity(TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_identity(TEXT, UUID, TEXT, JSONB) TO service_role;

-- ── 5. create_app() ────────────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Config accepts any JSONB, no special validation
  v_config := p_config;

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('app', 'project', 'partOf');

  -- 4. Upsert the app resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'app', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the app to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_app(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_app(TEXT, UUID, JSONB) TO service_role;

-- ── 6. create_credential() ─────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
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

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('credential', 'project', 'partOf');

  -- 4. Upsert the credential resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'credential', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the credential to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_credential(TEXT, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_credential(TEXT, UUID, TEXT, JSONB) TO service_role;

-- ── 7. create_server() ─────────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = p_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', p_project_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Config accepts any JSONB, no special validation
  v_config := p_config;

  -- 3. Validate link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('server', 'project', 'partOf');

  -- 4. Upsert the server resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'server', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5. Link the server to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_server(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_server(TEXT, UUID, JSONB) TO service_role;

-- ── 8. create_cron() ───────────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Validate project resource exists and has type='project'
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

  -- 3a. Validate schedules link pairing before schedules insert
  PERFORM public.validate_link_type_pairing('cron', 'skill', 'schedules');

  -- 3b. Validate partOf link pairing before partOf insert
  PERFORM public.validate_link_type_pairing('cron', 'project', 'partOf');

  -- 4. Upsert the cron resource
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), p_name, 'cron', 'active', v_config)
  ON CONFLICT (name) DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()
  RETURNING id INTO v_id;

  -- 5a. Link the cron to its skill via schedules
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_skill_resource_id, 'schedules')
  ON CONFLICT DO NOTHING;

  -- 5b. Link the cron to its project via partOf
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_id, p_project_id, 'partOf')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cron(TEXT, UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_cron(TEXT, UUID, UUID, TEXT, BOOLEAN, TEXT, TEXT[]) TO service_role;

-- ── 9. create_project() ────────────────────────────────────────────────────────
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
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- 2. Upsert idempotent: return existing project UUID if name taken
  INSERT INTO public.resources (id, name, type, status)
  VALUES (gen_random_uuid(), p_name, 'project', 'active')
  ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project(TEXT) TO service_role;
