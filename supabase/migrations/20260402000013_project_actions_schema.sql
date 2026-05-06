-- Story 1: Project Actions Schema
-- 1. Drop global UNIQUE(name) constraint on resources table
-- 2. Add partial UNIQUE index on resources(auth_user_id) WHERE type='user'
-- 3. Add partial UNIQUE index on resources(auth_user_id) WHERE type='project'
-- 4. Update provision_user() to use partial unique indexes instead of name uniqueness
-- 5. Update provision_sandbox() to use select-then-insert for credential resource
-- 6. Add validation_rules column to action_types
-- 7. Add project_id column to processes table

-- ── 1. Drop global UNIQUE(name) constraint ──────────────────────────────────
-- The constraint may be named resources_name_key (from UNIQUE inline) or
-- resources_name_unique (from explicit CONSTRAINT declaration). Drop both to
-- be safe across environments.
ALTER TABLE public.resources DROP CONSTRAINT IF EXISTS resources_name_key;
ALTER TABLE public.resources DROP CONSTRAINT IF EXISTS resources_name_unique;

-- ── 2. Partial UNIQUE index on auth_user_id for user resources ───────────────
-- Replaces name-based uniqueness for user resources. auth_user_id is the
-- stable identity anchor; name may be regenerated but uid never changes.
CREATE UNIQUE INDEX IF NOT EXISTS resources_auth_user_id_type_idx
  ON public.resources(auth_user_id)
  WHERE type = 'user' AND auth_user_id IS NOT NULL;

-- ── 3. Partial UNIQUE index on auth_user_id for project resources ────────────
-- Each auth user gets exactly one default project resource.
CREATE UNIQUE INDEX IF NOT EXISTS resources_auth_user_id_project_idx
  ON public.resources(auth_user_id)
  WHERE type = 'project' AND auth_user_id IS NOT NULL;

-- ── 4. Update provision_user() ───────────────────────────────────────────────
-- Switch from ON CONFLICT(name) to partial-index-based ON CONFLICT clauses.
-- User resource: conflict on (auth_user_id) WHERE type='user'.
-- Project resource: set auth_user_id on insert, conflict on (auth_user_id) WHERE type='project'.
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
  v_user_id UUID;
  v_project_id UUID;
  v_display_name TEXT;
BEGIN
  -- Derive display_name from email prefix: replace separators with spaces, init-cap each word
  v_display_name := initcap(replace(replace(replace(split_part(p_email, '@', 1), '.', ' '), '_', ' '), '-', ' '));

  -- Create or update user resource (idempotent via partial unique index on auth_user_id)
  INSERT INTO public.resources (id, name, type, status, auth_user_id, config)
  VALUES (
    gen_random_uuid(),
    'user:' || p_auth_user_id::text,
    'user',
    'active',
    p_auth_user_id,
    jsonb_build_object('display_name', v_display_name, 'description', 'builder')
  )
  ON CONFLICT (auth_user_id) WHERE type = 'user' AND auth_user_id IS NOT NULL
  DO UPDATE SET
    updated_at = now(),
    config = CASE
      -- Only set defaults if config is empty or null (don't overwrite user-customized values)
      WHEN resources.config IS NULL OR resources.config = '{}'::jsonb
        THEN jsonb_build_object('display_name', v_display_name, 'description', 'builder')
      ELSE resources.config
    END
  RETURNING id INTO v_user_id;

  -- Create or update project resource with auth_user_id for partial-index conflict resolution
  INSERT INTO public.resources (id, name, type, status, auth_user_id)
  VALUES (
    gen_random_uuid(),
    'project:' || p_auth_user_id::text,
    'project',
    'active',
    p_auth_user_id
  )
  ON CONFLICT (auth_user_id) WHERE type = 'project' AND auth_user_id IS NOT NULL
  DO UPDATE SET updated_at = now()
  RETURNING id INTO v_project_id;

  -- Create member_of link (idempotent via PK on from_id, to_id, link_type)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_id, v_project_id, 'member_of')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_user_id, v_project_id;
END;
$$;

-- ── 5. Update provision_sandbox() ───────────────────────────────────────────
-- Switch credential resource from ON CONFLICT(name) DO NOTHING to a
-- select-then-insert pattern, since the name unique constraint is gone.
DROP FUNCTION IF EXISTS public.provision_sandbox(uuid, text, text, text, text);
CREATE OR REPLACE FUNCTION public.provision_sandbox(
  p_user_resource_id UUID,
  p_server_name TEXT,
  p_ssh_key_name TEXT,
  p_public_key TEXT,
  p_hetzner_server_id TEXT DEFAULT NULL
)
RETURNS TABLE(server_resource_id UUID, credential_resource_id UUID, is_new BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_server_id UUID;
  v_credential_id UUID;
  v_is_new BOOLEAN;
  v_lock_key BIGINT;
BEGIN
  -- Ownership check: p_user_resource_id must belong to auth.uid()
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_user_resource_id
      AND auth_user_id::text = auth.uid()::text
      AND type = 'user'
  ) THEN
    RAISE EXCEPTION 'Access denied: user resource does not belong to authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Derive a deterministic 64-bit lock key from the server name
  v_lock_key := abs(hashtext(p_server_name)::bigint);

  -- Acquire a transaction-scoped advisory lock (blocking).
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check if the server resource already exists
  SELECT id INTO v_server_id FROM public.resources WHERE name = p_server_name AND type = 'server';

  IF v_server_id IS NULL THEN
    INSERT INTO public.resources (id, name, type, status, config)
    VALUES (
      gen_random_uuid(),
      p_server_name,
      'server',
      'active',
      jsonb_build_object('status', 'provisioning', 'hetzner_server_id', p_hetzner_server_id)
    )
    RETURNING id INTO v_server_id;
    v_is_new := TRUE;
  ELSE
    v_is_new := FALSE;
  END IF;

  -- Credential resource: select-then-insert (no ON CONFLICT(name) since constraint is dropped)
  SELECT id INTO v_credential_id FROM public.resources WHERE name = p_ssh_key_name AND type = 'credential';
  IF v_credential_id IS NULL THEN
    INSERT INTO public.resources (id, name, type, status, config)
    VALUES (
      gen_random_uuid(),
      p_ssh_key_name,
      'credential',
      'active',
      jsonb_build_object('public_key', p_public_key)
    )
    RETURNING id INTO v_credential_id;
  END IF;

  -- Parent link: server → user
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_server_id, p_user_resource_id, 'parent')
  ON CONFLICT DO NOTHING;

  -- Credential link: server → credential
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_server_id, v_credential_id, 'credential')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_server_id, v_credential_id, v_is_new;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── 6. Add validation_rules column to action_types ───────────────────────────
ALTER TABLE public.action_types ADD COLUMN IF NOT EXISTS validation_rules jsonb;

-- ── 7. Add project_id column to processes table ──────────────────────────────
ALTER TABLE public.processes
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.resources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS processes_project_id_idx ON public.processes(project_id);
