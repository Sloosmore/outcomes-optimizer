-- Story 3: Identity layer migration
-- Adds auth_provider column, widens auth_user_id to text, creates app.* helpers,
-- creates/rewrites canonical RPCs, creates 6 shims, updates action_types param_mapping.

-- ── Step 1: Add auth_provider column ──────────────────────────────────────────
ALTER TABLE public.resources ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'supabase';

-- ── Step 2: Widen auth_user_id from uuid to text ───────────────────────────────
-- Drop the FK constraint from baseline (resources_auth_user_id_fkey → auth.users(id))
-- before altering the column type, as you cannot change a uuid FK column to text.
ALTER TABLE public.resources DROP CONSTRAINT IF EXISTS resources_auth_user_id_fkey;
ALTER TABLE public.resources ALTER COLUMN auth_user_id TYPE text USING auth_user_id::text;

-- ── Step 3: Drop old unique indexes and recreate as composite ──────────────────
DROP INDEX IF EXISTS resources_auth_user_id_type_idx;
DROP INDEX IF EXISTS resources_auth_user_id_project_idx;
CREATE UNIQUE INDEX resources_auth_user_id_type_idx
  ON public.resources (auth_provider, auth_user_id)
  WHERE type = 'user' AND auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX resources_auth_user_id_project_idx
  ON public.resources (auth_provider, auth_user_id)
  WHERE type = 'project' AND auth_user_id IS NOT NULL;

-- ── Step 4: Backfill auth_provider for existing rows (column default handles new rows) ──
UPDATE public.resources SET auth_provider = 'supabase' WHERE auth_provider IS NULL;

-- ── Step 5: Create app schema and helpers ──────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_external_user_id()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT NULLIF(current_setting('app.external_user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION app.current_auth_provider()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(NULLIF(current_setting('app.auth_provider', true), ''), 'supabase')
$$;

CREATE OR REPLACE FUNCTION app.current_user_resource_id()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_external_id text;
  v_provider text;
  v_resource_id uuid;
BEGIN
  v_external_id := app.current_external_user_id();
  v_provider := app.current_auth_provider();

  IF v_external_id IS NOT NULL THEN
    -- BFF-mediated path: SET LOCAL app.* was used
    SELECT id INTO v_resource_id
    FROM public.resources
    WHERE auth_user_id = v_external_id
      AND auth_provider = v_provider
      AND type = 'user'
    LIMIT 1;
  ELSE
    -- CLI→PostgREST path: fall back to auth.uid()
    SELECT id INTO v_resource_id
    FROM public.resources
    WHERE auth_user_id = auth.uid()::text
      AND auth_provider = 'supabase'
      AND type = 'user'
    LIMIT 1;
  END IF;

  RETURN v_resource_id;
END;
$$;

-- ── Step 6: Create get_auth_user_resource_id() ────────────────────────────────
DROP FUNCTION IF EXISTS public.get_auth_user_resource_id();
CREATE OR REPLACE FUNCTION public.get_auth_user_resource_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM public.resources
  WHERE auth_user_id = auth.uid()::text
    AND auth_provider = 'supabase'
    AND type = 'user'
  LIMIT 1
$$;

-- ── Step 7: Update provision_user to set auth_provider = 'supabase' ───────────
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
  -- Derive display_name from email prefix
  v_display_name := initcap(replace(replace(replace(split_part(p_email, '@', 1), '.', ' '), '_', ' '), '-', ' '));

  -- Seed config with the computed display_name
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

  -- Create or update user resource (idempotent), now with auth_provider = 'supabase'
  INSERT INTO public.resources (id, name, type, status, auth_user_id, auth_provider, config)
  VALUES (
    gen_random_uuid(),
    'user:' || p_auth_user_id::text,
    'user',
    'active',
    p_auth_user_id::text,
    'supabase',
    v_config
  )
  ON CONFLICT (name) DO UPDATE SET
    updated_at = now(),
    auth_user_id = p_auth_user_id::text,
    auth_provider = 'supabase',
    config = CASE
      WHEN resources.config IS NULL OR resources.config = '{}'::jsonb
        THEN v_config
      ELSE resources.config
    END
  RETURNING id INTO v_user_id;

  -- Create or update project resource
  INSERT INTO public.resources (id, name, type, status)
  VALUES (gen_random_uuid(), 'project:' || p_auth_user_id::text, 'project', 'active')
  ON CONFLICT (name) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_project_id;

  -- Create member_of link (idempotent)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_id, v_project_id, 'member_of')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_user_id, v_project_id;
END;
$$;

-- ── Step 8: Canonical RPCs (identity derived from JWT, no legacy parameter) ───

-- 8a. Canonical add_user_repo
DROP FUNCTION IF EXISTS public.add_user_repo(text, text, boolean);
CREATE OR REPLACE FUNCTION public.add_user_repo(
  p_owner TEXT,
  p_repo_name TEXT,
  p_default BOOLEAN DEFAULT false
)
RETURNS TABLE(updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
  v_repos JSONB;
  v_new_repo JSONB;
BEGIN
  -- Derive user resource from JWT
  SELECT app.current_user_resource_id() INTO v_user_resource_id;
  IF v_user_resource_id IS NULL THEN
    RAISE EXCEPTION 'User resource not found for authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Get current repos array
  SELECT COALESCE(config->'repos', '[]'::jsonb) INTO v_repos
  FROM public.resources
  WHERE id = v_user_resource_id;

  -- Build new repo object
  v_new_repo := jsonb_build_object('owner', p_owner, 'name', p_repo_name);
  IF p_default THEN
    v_new_repo := v_new_repo || '{"default": true}'::jsonb;
  END IF;

  -- Remove existing entry with same owner/name (idempotent)
  SELECT jsonb_agg(r) INTO v_repos
  FROM jsonb_array_elements(v_repos) r
  WHERE NOT (r->>'owner' = p_owner AND r->>'name' = p_repo_name);

  IF v_repos IS NULL THEN
    v_repos := '[]'::jsonb;
  END IF;

  -- Append new entry
  v_repos := v_repos || jsonb_build_array(v_new_repo);

  -- Update resources
  UPDATE public.resources
  SET config = jsonb_set(COALESCE(config, '{}'), '{repos}', v_repos), updated_at = now()
  WHERE id = v_user_resource_id;

  RETURN QUERY SELECT true;
END;
$$;

REVOKE ALL ON FUNCTION public.add_user_repo(TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_user_repo(TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_user_repo(TEXT, TEXT, BOOLEAN) TO authenticated;

-- 8b. Canonical remove_user_repo
DROP FUNCTION IF EXISTS public.remove_user_repo(text, text);
CREATE OR REPLACE FUNCTION public.remove_user_repo(
  p_owner TEXT,
  p_name TEXT
)
RETURNS TABLE(updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
  v_repos JSONB;
BEGIN
  -- Derive user resource from JWT
  SELECT app.current_user_resource_id() INTO v_user_resource_id;
  IF v_user_resource_id IS NULL THEN
    RAISE EXCEPTION 'User resource not found for authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Get current repos array
  SELECT COALESCE(config->'repos', '[]'::jsonb) INTO v_repos
  FROM public.resources
  WHERE id = v_user_resource_id;

  -- Remove matching entry
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_repos
  FROM jsonb_array_elements(v_repos) r
  WHERE NOT (r->>'owner' = p_owner AND r->>'name' = p_name);

  -- Update resources
  UPDATE public.resources
  SET config = jsonb_set(COALESCE(config, '{}'), '{repos}', v_repos), updated_at = now()
  WHERE id = v_user_resource_id;

  RETURN QUERY SELECT true;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_user_repo(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_user_repo(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_user_repo(TEXT, TEXT) TO authenticated;

-- 8c. Canonical store_user_credential (rewrite)
DROP FUNCTION IF EXISTS public.store_user_credential(UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.store_user_credential(
  p_sandbox_name TEXT,
  p_provider TEXT,
  p_credential_value TEXT
)
RETURNS TABLE(credential_resource_id UUID, vault_secret_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
  v_credential_id UUID;
  v_vault_id UUID;
  v_secret_name TEXT;
  v_credential_name TEXT;
BEGIN
  -- Derive user resource from JWT
  SELECT app.current_user_resource_id() INTO v_user_resource_id;
  IF v_user_resource_id IS NULL THEN
    RAISE EXCEPTION 'User resource not found for authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Create vault secret with deterministic name (user-scoped)
  v_secret_name := 'credential-' || auth.uid()::text || '-' || p_sandbox_name || '-' || p_provider;

  -- Check for existing credential (idempotency: raise if exists)
  IF EXISTS (
    SELECT 1 FROM public.resources r
    JOIN public.resource_links rl ON rl.from_id = r.id
    WHERE r.type = 'credential'
      AND r.config->>'provider' = p_provider
      AND r.config->>'sandboxName' = p_sandbox_name
      AND rl.to_id = v_user_resource_id
      AND rl.link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Already linked: provider % is already linked to sandbox %', p_provider, p_sandbox_name
      USING ERRCODE = 'P0001';
  END IF;

  -- Store in vault
  SELECT vault.create_secret(p_credential_value, v_secret_name) INTO v_vault_id;

  -- Create credential resource
  v_credential_name := 'credential-' || v_user_resource_id::text || '-' || p_sandbox_name || '-' || p_provider;
  INSERT INTO public.resources (id, name, type, status, config, auth_user_id, auth_provider)
  VALUES (
    gen_random_uuid(),
    v_credential_name,
    'credential',
    'active',
    jsonb_build_object(
      'vaultSecretId', v_vault_id::text,
      'provider', p_provider,
      'sandboxName', p_sandbox_name
    ),
    auth.uid()::text,
    'supabase'
  )
  RETURNING id INTO v_credential_id;

  -- Link credential to user resource (parent = owned by)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_credential_id, v_user_resource_id, 'parent');

  RETURN QUERY SELECT v_credential_id, v_vault_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_user_credential(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_user_credential(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_user_credential(TEXT, TEXT, TEXT) TO authenticated;

-- 8d. Canonical store_github_installation (rewrite)
DROP FUNCTION IF EXISTS public.store_github_installation(UUID, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.store_github_installation(
  p_installation_id TEXT,
  p_token TEXT DEFAULT NULL,
  p_sandbox_name TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT 'github'
)
RETURNS TABLE(credential_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $function$
DECLARE
  v_user_resource_id UUID;
  v_credential_id UUID;
  v_token_vault_id UUID;
  v_cred_name TEXT;
BEGIN
  -- Derive user resource from JWT
  SELECT app.current_user_resource_id() INTO v_user_resource_id;
  IF v_user_resource_id IS NULL THEN
    RAISE EXCEPTION 'User resource not found for authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Deterministic name: sandbox+provider+user scoped
  v_cred_name := 'credential-' || v_user_resource_id::text || '-' || COALESCE(p_sandbox_name, 'default') || '-' || p_provider;

  -- Optionally vault the token
  IF p_token IS NOT NULL AND p_token <> '' THEN
    SELECT vault.create_secret(p_token, v_cred_name || '-token') INTO v_token_vault_id;
  END IF;

  -- Create or update credential resource
  INSERT INTO public.resources (id, name, type, status, config, auth_user_id, auth_provider)
  VALUES (
    gen_random_uuid(),
    v_cred_name,
    'credential',
    'active',
    jsonb_build_object(
      'installation_id', p_installation_id,
      'provider', p_provider,
      'sandboxName', p_sandbox_name
    ),
    auth.uid()::text,
    'supabase'
  )
  ON CONFLICT (name) DO UPDATE SET
    config = EXCLUDED.config,
    updated_at = now()
  RETURNING id INTO v_credential_id;

  -- Link credential → user (parent)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_credential_id, v_user_resource_id, 'parent')
  ON CONFLICT DO NOTHING;

  -- Link user → credential (github_app)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_user_resource_id, v_credential_id, 'github_app')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_credential_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.store_github_installation(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_github_installation(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_github_installation(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 8e. Canonical remove_github_installation (rewrite)
DROP FUNCTION IF EXISTS public.remove_github_installation(UUID);

CREATE OR REPLACE FUNCTION public.remove_github_installation()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $function$
DECLARE
  v_user_resource_id UUID;
  v_credential_id UUID;
BEGIN
  -- Derive user resource from JWT
  SELECT app.current_user_resource_id() INTO v_user_resource_id;
  IF v_user_resource_id IS NULL THEN
    RAISE EXCEPTION 'User resource not found for authenticated user'
      USING ERRCODE = '42501';
  END IF;

  -- Find and delete the github_app link, get credential ID
  SELECT to_id INTO v_credential_id
  FROM public.resource_links
  WHERE from_id = v_user_resource_id
    AND link_type = 'github_app'
  LIMIT 1;

  IF v_credential_id IS NOT NULL THEN
    -- Delete both directions of links involving the credential
    DELETE FROM public.resource_links
    WHERE (from_id = v_user_resource_id AND link_type = 'github_app')
       OR (from_id = v_credential_id AND to_id = v_user_resource_id AND link_type = 'parent');

    -- Delete the credential resource
    DELETE FROM public.resources
    WHERE id = v_credential_id
      AND type = 'credential';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_github_installation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_github_installation() TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_github_installation() TO authenticated;

-- 8f. Canonical provision_sandbox (rewrite)
DROP FUNCTION IF EXISTS public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.provision_sandbox(
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
  v_user_resource_id UUID;
  v_server_id     UUID;
  v_credential_id UUID;
  v_is_new        BOOLEAN;
  v_lock_key      BIGINT;
  v_server_config JSONB;
  r               RECORD;
BEGIN
  -- Derive user resource from JWT (both CLI and service role paths)
  IF auth.uid() IS NOT NULL THEN
    SELECT app.current_user_resource_id() INTO v_user_resource_id;
    IF v_user_resource_id IS NULL THEN
      RAISE EXCEPTION 'User resource not found for authenticated user'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- service role: no ownership check
    v_user_resource_id := NULL;
  END IF;

  -- Derive a deterministic 64-bit lock key from the server name
  v_lock_key := abs(hashtext(p_server_name)::bigint);

  -- Acquire a transaction-scoped advisory lock (blocking)
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check if the server resource already exists
  SELECT id INTO v_server_id FROM public.resources WHERE name = p_server_name AND type = 'server';

  IF v_server_id IS NULL THEN
    -- We are the winner: no prior provisioning started.

    IF p_hetzner_server_id IS NOT NULL THEN
      v_server_config := format('{"hetzner_server_id":%s}', to_json(p_hetzner_server_id))::jsonb;
    ELSE
      v_server_config := '{}'::jsonb;
    END IF;

    -- Loop over resource_type_properties for 'server' to fill in defaults
    FOR r IN
      SELECT field_name, default_value
      FROM public.resource_type_properties
      WHERE resource_type = 'server'
        AND default_value IS NOT NULL
    LOOP
      IF v_server_config ? r.field_name THEN
        CONTINUE;
      END IF;
      v_server_config := jsonb_set(v_server_config, ARRAY[r.field_name], r.default_value, true);
    END LOOP;

    INSERT INTO public.resources (id, name, type, status, config)
    VALUES (
      gen_random_uuid(),
      p_server_name,
      'server',
      'active',
      v_server_config
    )
    RETURNING id INTO v_server_id;

    v_is_new := TRUE;
  ELSE
    v_is_new := FALSE;
  END IF;

  -- Credential resource (idempotent upsert)
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (
    gen_random_uuid(),
    p_ssh_key_name,
    'credential',
    'active',
    format('{"public_key":%s}', to_json(p_public_key))::jsonb
  )
  ON CONFLICT (name) DO NOTHING;

  SELECT id INTO v_credential_id FROM public.resources WHERE name = p_ssh_key_name;

  -- Parent link: server → user (only if we have a user resource)
  IF v_user_resource_id IS NOT NULL THEN
    INSERT INTO public.resource_links (from_id, to_id, link_type)
    VALUES (v_server_id, v_user_resource_id, 'parent')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Credential link: server → credential
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_server_id, v_credential_id, 'credential')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_server_id, v_credential_id, v_is_new;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_sandbox(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── Step 9: Create 6 shims (legacy param declared but ignored, canonical called) ─

-- Shim 1: add_user_repo
DROP FUNCTION IF EXISTS public.add_user_repo(uuid, text, text, boolean);
CREATE OR REPLACE FUNCTION public.add_user_repo(
  p_user_resource_id UUID,
  p_owner TEXT,
  p_repo_name TEXT,
  p_default BOOLEAN DEFAULT false
)
RETURNS TABLE(updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.add_user_repo(p_owner, p_repo_name, p_default);
END;
$$;

REVOKE ALL ON FUNCTION public.add_user_repo(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_user_repo(UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_user_repo(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- Shim 2: remove_user_repo
-- Note: p_repo_name matches the parameter name used by legacy callers (tests use p_repo_name)
DROP FUNCTION IF EXISTS public.remove_user_repo(uuid, text, text);
CREATE OR REPLACE FUNCTION public.remove_user_repo(
  p_user_resource_id UUID,
  p_owner TEXT,
  p_repo_name TEXT
)
RETURNS TABLE(updated BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.remove_user_repo(p_owner, p_repo_name);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_user_repo(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_user_repo(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_user_repo(UUID, TEXT, TEXT) TO authenticated;

-- Shim 3: store_user_credential
DROP FUNCTION IF EXISTS public.store_user_credential(uuid, text, text, text);
CREATE OR REPLACE FUNCTION public.store_user_credential(
  p_user_resource_id UUID,
  p_sandbox_name TEXT,
  p_provider TEXT,
  p_credential_value TEXT
)
RETURNS TABLE(credential_resource_id UUID, vault_secret_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.store_user_credential(p_sandbox_name, p_provider, p_credential_value);
END;
$$;

REVOKE ALL ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- Shim 4: store_github_installation
DROP FUNCTION IF EXISTS public.store_github_installation(uuid, text, text, text, text);
CREATE OR REPLACE FUNCTION public.store_github_installation(
  p_user_resource_id UUID,
  p_installation_id TEXT,
  p_token TEXT DEFAULT NULL,
  p_sandbox_name TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT 'github'
)
RETURNS TABLE(credential_resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $function$
BEGIN
  RETURN QUERY SELECT * FROM public.store_github_installation(p_installation_id, p_token, p_sandbox_name, p_provider);
END;
$function$;

REVOKE ALL ON FUNCTION public.store_github_installation(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_github_installation(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_github_installation(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- Shim 5: remove_github_installation
DROP FUNCTION IF EXISTS public.remove_github_installation(uuid);
CREATE OR REPLACE FUNCTION public.remove_github_installation(
  p_user_resource_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $function$
BEGIN
  PERFORM public.remove_github_installation();
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_github_installation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_github_installation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_github_installation(UUID) TO authenticated;

-- Shim 6: provision_sandbox
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
BEGIN
  RETURN QUERY SELECT * FROM public.provision_sandbox(p_server_name, p_ssh_key_name, p_public_key, p_hetzner_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── Step 10: Update action_types param_mapping for 6 actions ─────────────────
-- Remove userResourceId mapping so CLI doesn't need to pass it

UPDATE public.action_types
SET
  input_schema = '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["owner", "name"],
    "properties": {
      "owner": { "type": "string" },
      "name": { "type": "string" },
      "default": { "type": "boolean" }
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{"owner": "p_owner", "name": "p_repo_name", "default": "p_default"}'::jsonb
WHERE name = 'add_user_repo';

UPDATE public.action_types
SET
  input_schema = '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["owner", "name"],
    "properties": {
      "owner": { "type": "string" },
      "name": { "type": "string" }
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{"owner": "p_owner", "name": "p_name"}'::jsonb
WHERE name = 'remove_user_repo';

UPDATE public.action_types
SET
  input_schema = '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["sandboxName", "provider", "credentialValue"],
    "properties": {
      "sandboxName": { "type": "string" },
      "provider": { "type": "string" },
      "credentialValue": { "type": "string" }
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{"sandboxName": "p_sandbox_name", "provider": "p_provider", "credentialValue": "p_credential_value"}'::jsonb
WHERE name = 'store_user_credential';

UPDATE public.action_types
SET
  input_schema = '{
    "type": "object",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "required": ["installationId"],
    "properties": {
      "token": {"type": "string", "description": "Optional GitHub access token to vault"},
      "installationId": {"type": "string", "description": "GitHub App installation ID"},
      "sandboxName": {"type": "string", "description": "Sandbox name for scoping"},
      "provider": {"type": "string", "description": "Provider name (default: github)"}
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{
    "token": "p_token",
    "installationId": "p_installation_id",
    "sandboxName": "p_sandbox_name",
    "provider": "p_provider"
  }'::jsonb
WHERE name = 'store_github_installation';

UPDATE public.action_types
SET
  input_schema = '{"type": "object", "$schema": "http://json-schema.org/draft-07/schema#", "properties": {}, "additionalProperties": false}'::jsonb,
  param_mapping = '{}'::jsonb
WHERE name = 'remove_github_installation';

UPDATE public.action_types
SET
  input_schema = '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["serverName", "sshKeyName", "publicKey"],
    "properties": {
      "serverName": { "type": "string" },
      "sshKeyName": { "type": "string" },
      "publicKey": { "type": "string" },
      "hetznerServerId": { "type": "string" }
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{"serverName": "p_server_name", "sshKeyName": "p_ssh_key_name", "publicKey": "p_public_key", "hetznerServerId": "p_hetzner_server_id"}'::jsonb
WHERE name = 'provision_sandbox';

-- ── Step 11: Register add_user_repo and remove_user_repo in action_types ──────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description)
VALUES (
  'add_user_repo',
  'add_user_repo',
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["owner", "name"],
    "properties": {
      "owner": { "type": "string" },
      "name": { "type": "string" },
      "default": { "type": "boolean" }
    },
    "additionalProperties": false
  }'::jsonb,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "updated": { "type": "boolean" }
    }
  }'::jsonb,
  '{"owner": "p_owner", "name": "p_repo_name", "default": "p_default"}'::jsonb,
  '{"updated": "updated"}'::jsonb,
  'Add a repository to the authenticated user config'
)
ON CONFLICT (name) DO UPDATE SET
  rpc_function = EXCLUDED.rpc_function,
  input_schema = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description = EXCLUDED.description;

INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description)
VALUES (
  'remove_user_repo',
  'remove_user_repo',
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["owner", "name"],
    "properties": {
      "owner": { "type": "string" },
      "name": { "type": "string" }
    },
    "additionalProperties": false
  }'::jsonb,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "updated": { "type": "boolean" }
    }
  }'::jsonb,
  '{"owner": "p_owner", "name": "p_name"}'::jsonb,
  '{"updated": "updated"}'::jsonb,
  'Remove a repository from the authenticated user config'
)
ON CONFLICT (name) DO UPDATE SET
  rpc_function = EXCLUDED.rpc_function,
  input_schema = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description = EXCLUDED.description;

-- ── Step 12: Rewrite name-based ownership functions ──────────────────────────
-- delete_user_credential, deprovision_sandbox, get_sandbox_server_info
-- These previously used the name-based lookup pattern — now updated to auth_user_id check

DROP FUNCTION IF EXISTS public.delete_user_credential(uuid);
CREATE OR REPLACE FUNCTION public.delete_user_credential(
  p_credential_resource_id UUID
)
RETURNS TABLE(deleted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_user_resource_id UUID;
  v_vault_secret_id UUID;
BEGIN
  -- Ownership check using auth_user_id column
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id = auth.uid()::text
    AND auth_provider = 'supabase'
    AND type = 'user';

  IF v_caller_user_resource_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_credential_resource_id
      AND to_id = v_caller_user_resource_id
      AND link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this credential'
      USING ERRCODE = '42501';
  END IF;

  -- Get vault secret ID
  SELECT (config->>'vaultSecretId')::uuid INTO v_vault_secret_id
  FROM public.resources
  WHERE id = p_credential_resource_id AND type = 'credential';

  -- Delete vault secret
  IF v_vault_secret_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_vault_secret_id;
  END IF;

  -- Delete all resource_links for this credential
  DELETE FROM public.resource_links
  WHERE from_id = p_credential_resource_id
     OR to_id = p_credential_resource_id;

  -- Delete the credential resource
  DELETE FROM public.resources WHERE id = p_credential_resource_id;

  RETURN QUERY SELECT true;
END;
$$;

DROP FUNCTION IF EXISTS public.deprovision_sandbox(uuid, text);
CREATE OR REPLACE FUNCTION public.deprovision_sandbox(
  p_server_resource_id UUID DEFAULT NULL,
  p_server_name TEXT DEFAULT NULL
)
RETURNS TABLE(deleted BOOLEAN, server_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_server_id UUID;
  v_server_name TEXT;
  v_credential_id UUID;
  v_caller_user_resource_id UUID;
BEGIN
  -- Resolve server resource ID
  IF p_server_resource_id IS NOT NULL THEN
    SELECT id, name INTO v_server_id, v_server_name
    FROM public.resources
    WHERE id = p_server_resource_id AND type = 'server';
  ELSIF p_server_name IS NOT NULL THEN
    SELECT id, name INTO v_server_id, v_server_name
    FROM public.resources
    WHERE name = p_server_name AND type = 'server';
  END IF;

  IF v_server_id IS NULL THEN
    RETURN QUERY SELECT false, p_server_name;
    RETURN;
  END IF;

  -- Ownership check: skip when called with service role (auth.uid() IS NULL).
  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_caller_user_resource_id
    FROM public.resources
    WHERE auth_user_id = auth.uid()::text
      AND auth_provider = 'supabase'
      AND type = 'user';

    IF v_caller_user_resource_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.resource_links
      WHERE from_id = v_server_id
        AND to_id = v_caller_user_resource_id
        AND link_type = 'parent'
    ) THEN
      RAISE EXCEPTION 'Access denied: you do not own this sandbox'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Find the credential resource linked to this server
  SELECT to_id INTO v_credential_id
  FROM public.resource_links
  WHERE from_id = v_server_id AND link_type = 'credential'
  LIMIT 1;

  -- Delete all resource_links where server is either side
  DELETE FROM public.resource_links
  WHERE from_id = v_server_id OR to_id = v_server_id;

  -- Delete credential resource
  IF v_credential_id IS NOT NULL THEN
    DELETE FROM public.resources WHERE id = v_credential_id;
  END IF;

  -- Delete server resource
  DELETE FROM public.resources WHERE id = v_server_id;

  RETURN QUERY SELECT true, v_server_name;
END;
$$;

DROP FUNCTION IF EXISTS public.get_sandbox_server_info(text);
CREATE OR REPLACE FUNCTION public.get_sandbox_server_info(
  p_server_name TEXT
)
RETURNS TABLE(server_resource_id UUID, hetzner_server_id TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_server_id UUID;
  v_hetzner_id TEXT;
  v_caller_user_resource_id UUID;
BEGIN
  -- Look up the server
  SELECT id, config->>'hetzner_server_id' INTO v_server_id, v_hetzner_id
  FROM public.resources
  WHERE name = p_server_name AND type = 'server';

  IF v_server_id IS NULL THEN
    RETURN;
  END IF;

  -- Ownership check using auth_user_id column
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id = auth.uid()::text
    AND auth_provider = 'supabase'
    AND type = 'user';

  IF v_caller_user_resource_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = v_server_id
      AND to_id = v_caller_user_resource_id
      AND link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this sandbox'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY SELECT v_server_id, v_hetzner_id;
END;
$$;

-- ── Step 13: Backfill NULL auth_user_id rows ──────────────────────────────────
UPDATE public.resources r
SET auth_user_id = (
  SELECT id::text FROM auth.users au
  WHERE split_part(r.name, ':', 2) = split_part(au.email, '@', 1)
  LIMIT 1
)
WHERE r.type = 'user' AND r.auth_user_id IS NULL;
