-- Story 5: Refactor provision_user to use property system for config assembly.
-- display_name is computed from email (dynamic input, not hardcoded).
-- description default ('builder') is now sourced from resource_type_properties.

DROP FUNCTION IF EXISTS public.provision_user(uuid, text);
CREATE OR REPLACE FUNCTION public.provision_user(
  p_auth_user_id UUID,
  p_email TEXT
)
RETURNS TABLE(user_resource_id UUID, project_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id      UUID;
  v_project_id   UUID;
  v_display_name TEXT;
  v_config       JSONB;
  r              RECORD;
BEGIN
  -- Derive display_name from email prefix: replace separators with spaces, init-cap each word
  v_display_name := initcap(replace(replace(replace(split_part(p_email, '@', 1), '.', ' '), '_', ' '), '-', ' '));

  -- Seed config with the computed display_name (dynamic input, not a hardcoded default).
  -- Use format+::jsonb to construct the initial object, keeping the property-system
  -- pattern clean (no hardcoded config assembly calls).
  v_config := format('{"display_name": %s}', to_json(v_display_name))::jsonb;

  -- Loop over resource_type_properties for 'user' to fill in any missing defaults
  -- (e.g. description='builder') and validate required fields
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'user'
  LOOP
    IF v_config ? r.field_name THEN
      CONTINUE; -- caller/compute already provided value, keep it
    END IF;

    IF r.required = true THEN
      RAISE EXCEPTION 'Missing required field "%" for resource type "user"', r.field_name
        USING ERRCODE = '22023';
    END IF;

    IF r.default_value IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[r.field_name], r.default_value, true);
    END IF;
  END LOOP;

  -- Create or update user resource (idempotent via ON CONFLICT on name unique constraint)
  INSERT INTO public.resources (id, name, type, status, auth_user_id, config)
  VALUES (
    gen_random_uuid(),
    'user:' || p_auth_user_id::text,
    'user',
    'active',
    p_auth_user_id,
    v_config
  )
  ON CONFLICT (name) DO UPDATE SET
    updated_at = now(),
    config = CASE
      -- Only set defaults if config is empty or null (don't overwrite user-customized values)
      WHEN resources.config IS NULL OR resources.config = '{}'::jsonb
        THEN v_config
      ELSE resources.config
    END
  RETURNING id INTO v_user_id;

  -- Create or update project resource (auth_user_id NULL per spec, no config needed)
  INSERT INTO public.resources (id, name, type, status)
  VALUES (gen_random_uuid(), 'project:' || p_auth_user_id::text, 'project', 'active')
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_project_id;

  -- Create member_of link (idempotent via PK on from_id, to_id, link_type)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_id, v_project_id, 'member_of')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_user_id, v_project_id;
END;
$$;
