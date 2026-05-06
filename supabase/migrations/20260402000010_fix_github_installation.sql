-- Fix store_github_installation to include provider, sandboxName, auth_user_id
-- and use a parent link for ownership checks (while keeping github_app link for semantics)

-- Drop old 3-param overload to avoid ambiguity when calling with 5 params
DROP FUNCTION IF EXISTS public.store_github_installation(UUID, TEXT, TEXT);

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
DECLARE
  v_credential_id UUID;
  v_token_vault_id UUID;
  v_cred_name TEXT;
BEGIN
  -- Ownership check: caller must own the user resource
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_user_resource_id
      AND type = 'user'
      AND auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this user resource'
      USING ERRCODE = '42501';
  END IF;

  -- Deterministic name: sandbox+provider+user scoped
  v_cred_name := 'credential-' || p_user_resource_id::text || '-' || COALESCE(p_sandbox_name, 'default') || '-' || p_provider;

  -- Optionally vault the token
  IF p_token IS NOT NULL AND p_token <> '' THEN
    SELECT vault.create_secret(p_token, v_cred_name || '-token') INTO v_token_vault_id;
  END IF;

  -- Create or update credential resource with auth_user_id and full config
  INSERT INTO public.resources (id, name, type, status, config, auth_user_id)
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
    auth.uid()
  )
  ON CONFLICT (name) DO UPDATE SET
    config = EXCLUDED.config,
    updated_at = now()
  RETURNING id INTO v_credential_id;

  -- Link credential → user (parent) for ownership checks and visibility
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (v_credential_id, p_user_resource_id, 'parent')
  ON CONFLICT DO NOTHING;

  -- Also link user → credential (github_app) for semantic querying (SC-6)
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_user_resource_id, v_credential_id, 'github_app')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_credential_id;
END;
$function$;

-- Update action_types input_schema and param_mapping to include new optional fields
UPDATE public.action_types
SET
  input_schema = '{
    "type": "object",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "required": ["userResourceId", "installationId"],
    "properties": {
      "token": {"type": "string", "description": "Optional GitHub access token to vault"},
      "installationId": {"type": "string", "description": "GitHub App installation ID"},
      "userResourceId": {"type": "string", "format": "uuid", "description": "UUID of the user resource"},
      "sandboxName": {"type": "string", "description": "Sandbox name for scoping"},
      "provider": {"type": "string", "description": "Provider name (default: github)"}
    },
    "additionalProperties": false
  }'::jsonb,
  param_mapping = '{
    "token": "p_token",
    "installationId": "p_installation_id",
    "userResourceId": "p_user_resource_id",
    "sandboxName": "p_sandbox_name",
    "provider": "p_provider"
  }'::jsonb
WHERE name = 'store_github_installation';
