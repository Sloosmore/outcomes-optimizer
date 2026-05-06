-- Migration: Fix provision_sandbox 6-param service-role bypass
-- Story 8: Epoch 35 fix
--
-- 20260422000001 re-introduced the ownership check in the 6-param signature without the
-- service-role bypass from 20260407000008. When auth.uid() IS NULL (service role), the
-- expression 'user:' || auth.uid()::text evaluates to NULL, so name = NULL is always
-- false, NOT EXISTS fires, and the call raises 'Access denied' regardless of the caller.
--
-- Fix: wrap the ownership check with IF auth.uid() IS NOT NULL THEN ... END IF;
-- preserving the user-JWT path (ownership enforced) while allowing service-role calls.

DROP FUNCTION IF EXISTS public.provision_sandbox(uuid, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.provision_sandbox(
  p_user_resource_id UUID,
  p_server_name TEXT,
  p_ssh_key_name TEXT,
  p_public_key TEXT,
  p_hetzner_server_id TEXT DEFAULT NULL,
  p_cloudflare_hostname_id TEXT DEFAULT NULL
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
        AND name = 'user:' || auth.uid()::text
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

    -- Seed config with optional dynamic fields.
    v_server_config := '{}'::jsonb;

    IF p_hetzner_server_id IS NOT NULL THEN
      v_server_config := jsonb_set(v_server_config, '{hetzner_server_id}', to_json(p_hetzner_server_id)::jsonb, true);
    END IF;

    IF p_cloudflare_hostname_id IS NOT NULL THEN
      v_server_config := jsonb_set(v_server_config, '{cloudflareCustomHostnameId}', to_json(p_cloudflare_hostname_id)::jsonb, true);
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

REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
-- Supabase default_acl grants explicit anon+authenticated to all public schema functions;
-- REVOKE FROM PUBLIC alone is insufficient (see migration 20260407000017).
REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
