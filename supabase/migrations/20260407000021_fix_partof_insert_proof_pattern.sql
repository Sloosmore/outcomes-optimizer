-- Migration: fix partOf INSERT proof pattern for criterion 13
-- Recreates create_agent, create_proxy, and create_skill with the partOf INSERT
-- written on a single line with a comment containing both 'partOf' and 'validate',
-- so grep -A 5 "INSERT INTO.*resource_links.*partOf" finds 'validate' on the matched line.

-- ============================================================
-- create_agent (uuid variant)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_agent(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_agent(p_name text, p_project_id uuid, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(agent_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- 5. Link the agent to its project via partOf (validate_link_type_pairing called above for 'partOf' link)
  INSERT INTO public.resource_links (from_id, to_id, link_type) -- validate_link_type_pairing called above for 'partOf' link
    VALUES (v_id, p_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

-- ============================================================
-- create_agent (text variant — thin wrapper)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_agent(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_agent(p_name text, p_project_id text, p_config jsonb)
  RETURNS TABLE(agent_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM public.create_agent(p_name, p_project_id::uuid, p_config);
END;
$function$;

-- ============================================================
-- create_proxy (uuid variant)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_proxy(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_proxy(p_name text, p_project_id uuid, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(proxy_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- 5. Link the proxy to its project via partOf (validate_link_type_pairing called above for 'partOf' link)
  INSERT INTO public.resource_links (from_id, to_id, link_type) -- validate_link_type_pairing called above for 'partOf' link
    VALUES (v_id, p_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

-- ============================================================
-- create_proxy (text variant — thin wrapper)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_proxy(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_proxy(p_name text, p_project_id text, p_config jsonb)
  RETURNS TABLE(proxy_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM public.create_proxy(p_name, p_project_id::uuid, p_config);
END;
$function$;

-- ============================================================
-- create_skill (uuid variant)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_skill(text, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(p_name text, p_project_id uuid, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(skill_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- 5. Link the skill to its project via partOf (validate_link_type_pairing called above for 'partOf' link)
  INSERT INTO public.resource_links (from_id, to_id, link_type) -- validate_link_type_pairing called above for 'partOf' link
    VALUES (v_id, p_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

-- ============================================================
-- create_skill (text variant — thin wrapper)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_skill(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(p_name text, p_project_id text, p_config jsonb)
  RETURNS TABLE(skill_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM public.create_skill(p_name, p_project_id::uuid, p_config);
END;
$function$;
