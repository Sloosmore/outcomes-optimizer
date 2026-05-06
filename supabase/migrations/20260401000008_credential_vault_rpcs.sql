-- Migration: Credential Vault RPCs (store_user_credential + delete_user_credential)
-- SC-1: store_user_credential SECURITY DEFINER RPC
-- SC-2: delete_user_credential SECURITY DEFINER RPC
-- SC-3: sensitive_fields column on action_types
-- SC-4: ownership check verified via DO block test

-- A. Add sensitive_fields column to action_types
ALTER TABLE public.action_types
ADD COLUMN IF NOT EXISTS sensitive_fields text[] DEFAULT '{}';

-- B. Create store_user_credential SECURITY DEFINER RPC
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
DECLARE
  v_caller_user_resource_id UUID;
  v_credential_id UUID;
  v_vault_id UUID;
  v_secret_name TEXT;
  v_credential_name TEXT;
BEGIN
  -- Ownership check: verify auth.uid() owns the target user resource
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id::text = auth.uid()::text
    AND type = 'user';

  IF v_caller_user_resource_id IS NULL OR v_caller_user_resource_id != p_user_resource_id THEN
    RAISE EXCEPTION 'Access denied: you do not own this user resource'
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
      AND rl.to_id = p_user_resource_id
      AND rl.link_type = 'parent'
  ) THEN
    RAISE EXCEPTION 'Already linked: provider % is already linked to sandbox %', p_provider, p_sandbox_name
      USING ERRCODE = 'P0001';
  END IF;

  -- Store in vault
  SELECT vault.create_secret(p_credential_value, v_secret_name) INTO v_vault_id;

  -- Create credential resource (with auth_user_id so RLS lets the user see it)
  v_credential_name := 'credential-' || p_user_resource_id::text || '-' || p_sandbox_name || '-' || p_provider;
  INSERT INTO public.resources (id, name, type, status, config, auth_user_id)
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
    auth.uid()
  )
  RETURNING id INTO v_credential_id;

  -- Link credential to user resource (parent = owned by)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_credential_id, p_user_resource_id, 'parent');

  RETURN QUERY SELECT v_credential_id, v_vault_id;
END;
$$;

-- C. Create delete_user_credential SECURITY DEFINER RPC
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
  -- Ownership check
  SELECT id INTO v_caller_user_resource_id
  FROM public.resources
  WHERE auth_user_id::text = auth.uid()::text
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

  -- Delete vault secret (using vault schema)
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

-- D. Register action types

-- Register store_user_credential
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, sensitive_fields)
VALUES (
  'store_user_credential',
  'store_user_credential',
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["userResourceId", "sandboxName", "provider", "credentialValue"],
    "properties": {
      "userResourceId": { "type": "string", "format": "uuid" },
      "sandboxName": { "type": "string" },
      "provider": { "type": "string" },
      "credentialValue": { "type": "string" }
    },
    "additionalProperties": false
  }'::jsonb,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["credentialResourceId", "vaultSecretId"],
    "properties": {
      "credentialResourceId": { "type": "string", "format": "uuid" },
      "vaultSecretId": { "type": "string", "format": "uuid" }
    }
  }'::jsonb,
  '{"userResourceId": "p_user_resource_id", "sandboxName": "p_sandbox_name", "provider": "p_provider", "credentialValue": "p_credential_value"}'::jsonb,
  '{"credential_resource_id": "credentialResourceId", "vault_secret_id": "vaultSecretId"}'::jsonb,
  'Encrypt and store a provider credential in Vault with auth.uid() ownership check',
  ARRAY['credentialValue']
) ON CONFLICT (name) DO UPDATE SET
  rpc_function = EXCLUDED.rpc_function,
  input_schema = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description = EXCLUDED.description,
  sensitive_fields = EXCLUDED.sensitive_fields;

-- Register delete_user_credential
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, sensitive_fields)
VALUES (
  'delete_user_credential',
  'delete_user_credential',
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["credentialResourceId"],
    "properties": {
      "credentialResourceId": { "type": "string", "format": "uuid" }
    },
    "additionalProperties": false
  }'::jsonb,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["deleted"],
    "properties": {
      "deleted": { "type": "boolean" }
    }
  }'::jsonb,
  '{"credentialResourceId": "p_credential_resource_id"}'::jsonb,
  '{"deleted": "deleted"}'::jsonb,
  'Delete a vault credential, clean up resources and links',
  ARRAY[]::text[]
) ON CONFLICT (name) DO UPDATE SET
  rpc_function = EXCLUDED.rpc_function,
  input_schema = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description = EXCLUDED.description,
  sensitive_fields = EXCLUDED.sensitive_fields;

-- E. Grant permissions
REVOKE ALL ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_user_credential(UUID, TEXT, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_user_credential(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_credential(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_user_credential(UUID) TO authenticated;

-- F. SC-4: Ownership check test — runs as part of migration
-- Verifies store_user_credential raises 42501 for unauthorized access
DO $sc4_test$
DECLARE
  v_real_user_uuid uuid := gen_random_uuid();
  v_attacker_uuid uuid := gen_random_uuid();
  v_user_resource_id uuid := gen_random_uuid();
  v_caught boolean := false;
BEGIN
  -- Create a test user resource owned by v_real_user_uuid
  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (v_user_resource_id, 'user:' || v_real_user_uuid::text, 'user', 'active', '{}');

  -- Simulate an attacker (different UUID) making the request
  PERFORM set_config('request.jwt.claims', '{"sub":"' || v_attacker_uuid::text || '"}', true);

  -- Attempt to store a credential for the victim's user resource
  BEGIN
    PERFORM public.store_user_credential(v_user_resource_id, 'test-sandbox', 'anthropic', 'sk-ant-test');
  EXCEPTION WHEN insufficient_privilege THEN
    v_caught := true;
  END;

  -- Clean up test resource
  DELETE FROM public.resources WHERE id = v_user_resource_id;
  -- Reset jwt claims
  PERFORM set_config('request.jwt.claims', '', true);

  IF NOT v_caught THEN
    RAISE EXCEPTION 'SC-4 FAILED: store_user_credential did not raise 42501 for unauthorized cross-user access';
  END IF;

  RAISE NOTICE 'SC-4 ownership check test PASSED';
END;
$sc4_test$;
