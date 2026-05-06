-- Migration: Cloudflare for SaaS DNS — Story 2
--
-- Changes:
-- 1. Convert existing type='sandbox' resources to type='server' (criterion 4)
-- 2. Add 'cloudflareCustomHostnameId' to server resource_type_properties schema (optional)
-- 3. Add link_type 'cloudflare_hostname' for tracking CF hostname ownership
-- 4. Update provision_sandbox to accept and store cloudflareCustomHostnameId

-- ── 1. Convert sandbox → server (criterion 4) ───────────────────────────────
--
-- All 'sandbox' type resources are legacy server resources. Migrate them to 'server'
-- so the system has a single canonical type for compute resources.
UPDATE public.resources
SET type = 'server'
WHERE type = 'sandbox';

-- ── 2. Add cloudflareCustomHostnameId to server resource_type_properties ─────
--
-- This optional field tracks the CF custom hostname ID associated with a sandbox
-- server, enabling deprovision and reconciliation sweeps.
INSERT INTO public.resource_type_properties (resource_type, field_name, required, default_value)
VALUES (
  'server',
  'cloudflareCustomHostnameId',
  false,
  NULL
)
ON CONFLICT (resource_type, field_name) DO NOTHING;

-- ── 3. Add cloudflare_hostname link type ─────────────────────────────────────
INSERT INTO public.link_types (name, description)
VALUES ('cloudflare_hostname', 'A server resource is represented by a Cloudflare custom hostname')
ON CONFLICT (name) DO NOTHING;

-- link_type_rules: server can have a cloudflare_hostname link (0:1 per server)
INSERT INTO public.link_type_rules (link_type, from_type, to_type)
VALUES ('cloudflare_hostname', 'server', 'server')
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- ── 4. Update provision_sandbox to accept cloudflareCustomHostnameId ──────────
--
-- New optional parameter: p_cloudflare_hostname_id TEXT DEFAULT NULL
-- When provided, stored in the server's config at creation time.
-- The BFF calls provision_sandbox first (DB-level idempotency lock), then calls
-- the CF API, then calls update_sandbox_config to store the hostname ID.
-- This split avoids doing external API calls inside a DB transaction.

DROP FUNCTION IF EXISTS public.provision_sandbox(uuid, text, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.provision_sandbox(
  p_user_resource_id UUID,
  p_server_name TEXT,
  p_ssh_key_name TEXT,
  p_public_key TEXT,
  p_hetzner_server_id TEXT DEFAULT NULL,
  p_cloudflare_hostname_id TEXT DEFAULT NULL,
  p_auth_uid UUID DEFAULT NULL
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
  v_caller_uid    UUID;
  r               RECORD;
BEGIN
  -- Ownership check: p_user_resource_id must belong to the calling user.
  -- Prefer p_auth_uid (explicit, works for service-role callers) over auth.uid()
  -- (returns NULL when called via service-role, which would silently fail the check).
  v_caller_uid := COALESCE(p_auth_uid, auth.uid());
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'Access denied: no authenticated user identity provided (p_auth_uid or auth.uid())'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_user_resource_id
      AND name = 'user:' || v_caller_uid::text
      AND type = 'user'
  ) THEN
    RAISE EXCEPTION 'Access denied: user resource does not belong to authenticated user'
      USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.provision_sandbox(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- ── 5. Add update_server_config RPC for post-provision CF hostname storage ────
--
-- Called by the BFF after the CF API call succeeds to persist the hostname ID.
-- Uses service_role only (not user-facing — the BFF acts as service_role here).
-- Includes parent-link ownership check so even bugs that pass user-controlled
-- p_server_resource_id to this RPC cannot corrupt another user's server config.
DROP FUNCTION IF EXISTS public.update_server_config(uuid, jsonb, uuid);
CREATE OR REPLACE FUNCTION public.update_server_config(
  p_server_resource_id UUID,
  p_config_patch JSONB,
  p_auth_uid UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_uid UUID;
BEGIN
  -- Ownership check: server's parent user must match the calling user.
  -- Prefer p_auth_uid over auth.uid() (auth.uid() is NULL for service-role callers).
  v_caller_uid := COALESCE(p_auth_uid, auth.uid());
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'Access denied: no authenticated user identity provided'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.resource_links rl
    JOIN public.resources u ON u.id = rl.to_id
    WHERE rl.from_id = p_server_resource_id
      AND rl.link_type = 'parent'
      AND u.type = 'user'
      AND u.name = 'user:' || v_caller_uid::text
  ) THEN
    RAISE EXCEPTION 'Access denied: server does not belong to authenticated user'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.resources
  SET config = config || p_config_patch
  WHERE id = p_server_resource_id
    AND type = 'server';

  RETURN FOUND;
END;
$$;

-- Drop the prior 2-arg signature so the new 3-arg signature is the canonical one.
DROP FUNCTION IF EXISTS public.update_server_config(UUID, JSONB);
REVOKE ALL ON FUNCTION public.update_server_config(UUID, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_server_config(UUID, JSONB, UUID) TO service_role;

-- ── 5b. Update action_types row for provision_sandbox to include authUid ─────
-- The BFF (service-role caller) must pass the JWT sub explicitly because auth.uid()
-- returns NULL for service-role. The new p_auth_uid parameter receives this.
UPDATE public.action_types
SET input_schema = '{
  "type": "object",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "required": ["userResourceId", "serverName", "sshKeyName", "publicKey"],
  "properties": {
    "publicKey":              { "type": "string" },
    "serverName":             { "type": "string" },
    "sshKeyName":             { "type": "string" },
    "userResourceId":         { "type": "string", "description": "UUID of the user resource" },
    "hetznerServerId":        { "type": "string", "description": "Optional Hetzner server ID" },
    "cloudflareHostnameId":   { "type": "string", "description": "Optional CF custom hostname ID" },
    "authUid":                { "type": "string", "description": "JWT sub claim of the calling user" }
  },
  "additionalProperties": false
}'::jsonb,
param_mapping = '{
  "publicKey":            "p_public_key",
  "serverName":           "p_server_name",
  "sshKeyName":           "p_ssh_key_name",
  "userResourceId":       "p_user_resource_id",
  "hetznerServerId":      "p_hetzner_server_id",
  "cloudflareHostnameId": "p_cloudflare_hostname_id",
  "authUid":              "p_auth_uid"
}'::jsonb
WHERE name = 'provision_sandbox';

-- ── 6. Smoke test ─────────────────────────────────────────────────────────────
DO $smoke_test$
DECLARE
  v_sandbox_count INT;
  v_fn_exists BOOLEAN;
  v_update_fn_exists BOOLEAN;
  v_prop_exists BOOLEAN;
BEGIN
  -- Criterion 4: no more 'sandbox' type resources
  SELECT COUNT(*) INTO v_sandbox_count
  FROM public.resources WHERE type = 'sandbox';

  IF v_sandbox_count != 0 THEN
    RAISE EXCEPTION 'Smoke test FAILED: % sandbox resources remain after migration', v_sandbox_count;
  END IF;

  -- Check provision_sandbox with 6 args exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name = 'provision_sandbox'
  ) INTO v_fn_exists;

  IF NOT v_fn_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: provision_sandbox function not found';
  END IF;

  -- Check update_server_config exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public'
      AND routine_name = 'update_server_config'
  ) INTO v_update_fn_exists;

  IF NOT v_update_fn_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: update_server_config function not found';
  END IF;

  -- Check cloudflareCustomHostnameId property was added
  SELECT EXISTS (
    SELECT 1 FROM public.resource_type_properties
    WHERE resource_type = 'server' AND field_name = 'cloudflareCustomHostnameId'
  ) INTO v_prop_exists;

  IF NOT v_prop_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: cloudflareCustomHostnameId property not found in resource_type_properties';
  END IF;

  RAISE NOTICE 'Smoke test PASSED: 0 sandbox resources, provision_sandbox updated, update_server_config added, cloudflareCustomHostnameId property registered';
END;
$smoke_test$;
