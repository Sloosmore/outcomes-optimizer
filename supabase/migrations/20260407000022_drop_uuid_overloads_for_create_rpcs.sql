-- Migration 000022: Drop uuid overloads for create_agent, create_proxy, create_skill
-- and replace text overloads with standalone implementations.
--
-- Migration 000021 left text overloads as thin wrappers delegating to uuid overloads.
-- Once we drop the uuid overloads, the text overloads break. This migration:
--   1. Replaces text overloads with full standalone implementations (casting p_project_id::uuid internally)
--   2. Drops the uuid overloads
--
-- Supabase JS RPC sends p_project_id as a JSON string (text), which matched BOTH overloads
-- causing "Could not choose the best candidate function" ambiguity. With only text overloads
-- remaining, JS callers get exact matches and psql callers benefit from uuid->text implicit cast.

-- ============================================================
-- create_agent (text variant — full implementation, no delegation)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_agent(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_agent(p_name text, p_project_id text, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(agent_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id         UUID;
  v_project_id UUID;
  v_config     JSONB;
  v_field      TEXT;
  v_req        BOOLEAN;
  v_default    JSONB;
  r            RECORD;
BEGIN
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- Cast text to uuid
  v_project_id := p_project_id::uuid;

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = v_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', v_project_id
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
    VALUES (v_id, v_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_agent(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_agent(TEXT, TEXT, JSONB) TO service_role;

-- ============================================================
-- create_proxy (text variant — full implementation, no delegation)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_proxy(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_proxy(p_name text, p_project_id text, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(proxy_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id         UUID;
  v_project_id UUID;
  v_config     JSONB;
  v_field      TEXT;
  v_req        BOOLEAN;
  v_default    JSONB;
  r            RECORD;
BEGIN
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- Cast text to uuid
  v_project_id := p_project_id::uuid;

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = v_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', v_project_id
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
    VALUES (v_id, v_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_proxy(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_proxy(TEXT, TEXT, JSONB) TO service_role;

-- ============================================================
-- create_skill (text variant — full implementation, no delegation)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_skill(text, text, jsonb);
CREATE OR REPLACE FUNCTION public.create_skill(p_name text, p_project_id text, p_config jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE(skill_resource_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id         UUID;
  v_project_id UUID;
  v_config     JSONB;
  v_field      TEXT;
  v_req        BOOLEAN;
  v_default    JSONB;
  r            RECORD;
BEGIN
  -- 1. Validate name first
  PERFORM public.validate_resource_name(p_name);

  -- Cast text to uuid
  v_project_id := p_project_id::uuid;

  -- 2. Validate project resource exists and has type='project'
  IF NOT EXISTS (SELECT 1 FROM public.resources WHERE id = v_project_id AND type = 'project') THEN
    RAISE EXCEPTION 'Project not found: %', v_project_id
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
    VALUES (v_id, v_project_id, 'partOf')
    ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_skill(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_skill(TEXT, TEXT, JSONB) TO service_role;

-- ============================================================
-- Drop uuid overloads (now that text overloads are standalone)
-- ============================================================
DROP FUNCTION IF EXISTS public.create_agent(text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.create_proxy(text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.create_skill(text, uuid, jsonb);
