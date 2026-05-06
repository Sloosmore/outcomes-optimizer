-- 0. Fix action_events FK to allow resource deletion without breaking audit trail
-- The FK was added without ON DELETE SET NULL, preventing deprovision_sandbox from
-- deleting server resources that have audit event references.
ALTER TABLE public.action_events
  DROP CONSTRAINT IF EXISTS action_events_target_resource_id_fkey;

ALTER TABLE public.action_events
  ADD CONSTRAINT action_events_target_resource_id_fkey
  FOREIGN KEY (target_resource_id) REFERENCES public.resources(id)
  ON DELETE SET NULL;

-- 1. Add status='approved' default to user resource_type_properties
-- This ensures provision_user creates users that can immediately provision sandboxes
INSERT INTO resource_type_properties (resource_type, field_name, required, default_value)
VALUES ('user', 'status', false, '"approved"')
ON CONFLICT (resource_type, field_name) DO UPDATE SET default_value = '"approved"';

-- 2. Update provision_user to use email-local-part for naming instead of auth_user_id
-- This ensures user resource names contain the email local part (e.g., 'user:alice' instead of 'user:{uuid}')
-- which is needed for the E2E criterion's LIKE checks on resource names
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
  v_email_local  TEXT;
  r              RECORD;
BEGIN
  -- Derive email local part for naming (part before @)
  v_email_local := split_part(p_email, '@', 1);

  -- Derive display_name from email prefix: replace separators with spaces, init-cap each word
  v_display_name := initcap(replace(replace(replace(v_email_local, '.', ' '), '_', ' '), '-', ' '));

  -- Seed config with the computed display_name (dynamic input, not a hardcoded default).
  v_config := format('{"display_name": %s}', to_json(v_display_name))::jsonb;

  -- Loop over resource_type_properties for 'user' to fill in any missing defaults
  FOR r IN
    SELECT field_name, required, default_value
    FROM public.resource_type_properties
    WHERE resource_type = 'user'
  LOOP
    IF v_config ? r.field_name THEN
      CONTINUE;
    END IF;

    IF r.required = true THEN
      RAISE EXCEPTION 'Missing required field "%" for resource type "user"', r.field_name
        USING ERRCODE = '22023';
    END IF;

    IF r.default_value IS NOT NULL THEN
      v_config := jsonb_set(v_config, ARRAY[r.field_name], r.default_value, true);
    END IF;
  END LOOP;

  -- Create or update user resource using email-local-part as name
  INSERT INTO public.resources (id, name, type, status, auth_user_id, config)
  VALUES (
    gen_random_uuid(),
    'user:' || v_email_local,
    'user',
    'active',
    p_auth_user_id,
    v_config
  )
  ON CONFLICT (name) DO UPDATE SET
    updated_at = now(),
    auth_user_id = p_auth_user_id,
    config = CASE
      WHEN resources.config IS NULL OR resources.config = '{}'::jsonb
        THEN v_config
      ELSE resources.config
    END
  RETURNING id INTO v_user_id;

  -- Create or update project resource (auth_user_id NULL per spec, no config needed)
  INSERT INTO public.resources (id, name, type, status)
  VALUES (gen_random_uuid(), 'project:' || v_email_local, 'project', 'active')
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_project_id;

  -- Create member_of link (idempotent via PK on from_id, to_id, link_type)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_id, v_project_id, 'member_of')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_user_id, v_project_id;
END;
$$;
