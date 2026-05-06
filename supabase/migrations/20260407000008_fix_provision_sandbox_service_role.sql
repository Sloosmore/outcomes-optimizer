-- Story 9: Fix provision_sandbox and deprovision_sandbox to allow service role calls.
-- When auth.uid() IS NULL (service role JWT), skip the ownership check.
-- When auth.uid() IS NOT NULL (authenticated user JWT), enforce ownership.
-- This fixes the regression introduced in story 6's refactoring where the BFF
-- (which uses service role) could not call provision_sandbox or deprovision_sandbox.

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
  v_server_id     UUID;
  v_credential_id UUID;
  v_is_new        BOOLEAN;
  v_lock_key      BIGINT;
  v_server_config JSONB;
  r               RECORD;
BEGIN
  -- Ownership check: skip when called with service role (auth.uid() IS NULL).
  -- When auth.uid() IS NOT NULL (authenticated user), enforce ownership.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.resources
      WHERE id = p_user_resource_id
        AND auth_user_id::text = auth.uid()::text
        AND type = 'user'
    ) THEN
      RAISE EXCEPTION 'Access denied: user resource does not belong to authenticated user'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Derive a deterministic 64-bit lock key from the server name
  v_lock_key := abs(hashtext(p_server_name)::bigint);

  -- Acquire a transaction-scoped advisory lock (blocking).
  -- Concurrent transactions for the same server name will queue up here.
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check if the server resource already exists (set by a previous winner)
  SELECT id INTO v_server_id FROM public.resources WHERE name = p_server_name AND type = 'server';

  IF v_server_id IS NULL THEN
    -- We are the winner: no prior provisioning started.

    -- Seed config with the dynamic hetzner_server_id if provided.
    -- Use format+::jsonb to keep the property-system pattern clean.
    IF p_hetzner_server_id IS NOT NULL THEN
      v_server_config := format('{"hetzner_server_id":%s}', to_json(p_hetzner_server_id))::jsonb;
    ELSE
      v_server_config := '{}'::jsonb;
    END IF;

    -- Loop over resource_type_properties for 'server' to fill in defaults only
    -- (e.g. status='provisioning'). Required fields without defaults (e.g. ip) are
    -- lifecycle-phase fields assigned post-provisioning and are intentionally skipped here.
    FOR r IN
      SELECT field_name, default_value
      FROM public.resource_type_properties
      WHERE resource_type = 'server'
        AND default_value IS NOT NULL
    LOOP
      IF v_server_config ? r.field_name THEN
        CONTINUE; -- already provided, keep it
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
    -- Another transaction already inserted this row
    v_is_new := FALSE;
  END IF;

  -- Credential resource (idempotent upsert regardless of winner/loser).
  -- SSH key credential: only public_key applies here. Do NOT run the property-system
  -- loop for 'credential' type — dopplerProject is required there and does not apply.
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

-- Fix deprovision_sandbox: same pattern — skip ownership check when auth.uid() IS NULL (service role).
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
  -- Resolve server resource ID — prefer explicit UUID, fall back to name lookup.
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
    -- Nothing to delete — return deleted=false
    RETURN QUERY SELECT false, p_server_name;
    RETURN;
  END IF;

  -- Ownership check: skip when called with service role (auth.uid() IS NULL).
  -- When auth.uid() IS NOT NULL (authenticated user), enforce ownership.
  IF auth.uid() IS NOT NULL THEN
    SELECT id INTO v_caller_user_resource_id
    FROM public.resources
    WHERE auth_user_id::text = auth.uid()::text
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

  -- Find the credential resource linked to this server (link_type = 'credential')
  SELECT to_id INTO v_credential_id
  FROM public.resource_links
  WHERE from_id = v_server_id AND link_type = 'credential'
  LIMIT 1;

  -- Delete all resource_links where server is either side
  DELETE FROM public.resource_links
  WHERE from_id = v_server_id OR to_id = v_server_id;

  -- Delete credential resource (if found and not shared)
  IF v_credential_id IS NOT NULL THEN
    DELETE FROM public.resources WHERE id = v_credential_id;
  END IF;

  -- Delete server resource itself
  DELETE FROM public.resources WHERE id = v_server_id;

  RETURN QUERY SELECT true, v_server_name;
END;
$$;

REVOKE ALL ON FUNCTION public.deprovision_sandbox(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.deprovision_sandbox(UUID, TEXT) TO authenticated;
