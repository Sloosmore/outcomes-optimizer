-- provision_user_trigger migration
-- Adds redeemed_by link_type and updates provision_user to handle access_code metadata
-- Modifies the existing handle_new_auth_user trigger function to pass user metadata

-- Add redeemed_by link type (idempotent)
INSERT INTO public.link_types (name, description, cardinality)
VALUES ('redeemed_by', 'Access code was redeemed by this user resource', 'many-to-one')
ON CONFLICT (name) DO NOTHING;

-- Update provision_user to accept optional metadata and handle access_code
CREATE OR REPLACE FUNCTION public.provision_user(
  p_auth_user_id uuid,
  p_email text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(user_resource_id uuid, project_resource_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_user_id UUID;
  v_project_id UUID;
  v_access_code text;
  v_code_id uuid;
BEGIN
  -- Create or update user resource (idempotent via ON CONFLICT on name unique constraint)
  INSERT INTO public.resources (id, name, type, status, auth_user_id)
  VALUES (gen_random_uuid(), 'user:' || p_auth_user_id::text, 'user', 'active', p_auth_user_id)
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_user_id;

  -- Create or update project resource (auth_user_id NULL per spec)
  INSERT INTO public.resources (id, name, type, status)
  VALUES (gen_random_uuid(), 'project:' || p_auth_user_id::text, 'project', 'active')
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_project_id;

  -- Create member_of link (idempotent via PK on from_id, to_id, link_type)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_id, v_project_id, 'member_of')
  ON CONFLICT DO NOTHING;

  -- Handle access_code if present in metadata
  v_access_code := p_metadata->>'access_code';

  IF v_access_code IS NOT NULL AND v_access_code <> '' THEN
    -- Atomically claim the access code: only succeeds if still active.
    -- Concurrent callers see NULL if another transaction already claimed it.
    UPDATE public.resources
    SET status = 'used'
    WHERE name = v_access_code
      AND type = 'access-code'
      AND status = 'active'
    RETURNING id INTO v_code_id;

    IF v_code_id IS NOT NULL THEN
      -- Create redeemed_by link: from user resource TO the code resource
      INSERT INTO public.resource_links (from_id, to_id, link_type)
      VALUES (v_user_id, v_code_id, 'redeemed_by')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  RETURN QUERY SELECT v_user_id, v_project_id;
END;
$$;

-- Update handle_new_auth_user to pass raw_user_meta_data to provision_user
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  PERFORM public.provision_user(
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data, '{}'::jsonb)
  );
  RETURN NEW;
END;
$$;
