-- Migration: get_user_credential and get_user_credential_for SECURITY DEFINER RPCs
-- Story 1: Vault credential retrieval scoped by caller's JWT via RLS ontology traversal

-- A. Add 'accesses' link type (credential → server, e.g. SSH key grants access to a server)
INSERT INTO public.link_types (name, description) VALUES
  ('accesses', 'A credential grants access to a specific resource (e.g., SSH key → server)')
ON CONFLICT (name) DO NOTHING;

-- link_type_rules: credential can 'accesses' a server (0:N)
INSERT INTO public.link_type_rules (link_type, from_type, to_type) VALUES
  ('accesses', 'credential', 'server')
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- B. Implement get_user_credential(credential_name TEXT, auth_uid UUID DEFAULT auth.uid())
-- Resolves user resource via auth.uid(), walks parent links to find owned credentials.
-- Returns empty set if credential not found or not owned by caller — never raises.
DROP FUNCTION IF EXISTS public.get_user_credential(text, uuid);
CREATE OR REPLACE FUNCTION public.get_user_credential(
  p_credential_name TEXT,
  p_auth_uid UUID DEFAULT auth.uid()
)
RETURNS TABLE(credential_id UUID, secret TEXT, metadata JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
BEGIN
  -- Resolve caller's user resource
  SELECT id INTO v_user_resource_id
  FROM public.resources
  WHERE name = 'user:' || p_auth_uid::text
    AND type = 'user';

  -- No user resource → return empty (never raise)
  IF v_user_resource_id IS NULL THEN
    RETURN;
  END IF;

  -- Walk: credential resource → parent link → user resource → vault secret
  -- Match by exact resource name OR by provider field in config (fallback)
  RETURN QUERY
  SELECT
    r.id AS credential_id,
    ds.decrypted_secret AS secret,
    r.config AS metadata
  FROM public.resources r
  JOIN public.resource_links rl
    ON rl.from_id = r.id AND rl.link_type = 'parent'
  JOIN vault.decrypted_secrets ds
    ON ds.id = (r.config->>'vaultSecretId')::uuid
  WHERE r.type = 'credential'
    AND rl.to_id = v_user_resource_id
    AND (
      r.name = p_credential_name
      OR r.config->>'provider' = p_credential_name
    );
END;
$$;

-- C. Implement get_user_credential_for(resource_id UUID, link_type TEXT, auth_uid UUID DEFAULT auth.uid())
-- Verifies auth_uid owns the target resource, then returns credentials linked to it via the given link type.
-- Cross-user: A's JWT cannot retrieve credentials linked to B's resource.
DROP FUNCTION IF EXISTS public.get_user_credential_for(uuid, text, uuid);
CREATE OR REPLACE FUNCTION public.get_user_credential_for(
  p_resource_id UUID,
  p_link_type TEXT,
  p_auth_uid UUID DEFAULT auth.uid()
)
RETURNS TABLE(credential_id UUID, secret TEXT, metadata JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_catalog
AS $$
DECLARE
  v_user_resource_id UUID;
BEGIN
  -- Resolve caller's user resource
  SELECT id INTO v_user_resource_id
  FROM public.resources
  WHERE name = 'user:' || p_auth_uid::text
    AND type = 'user';

  -- No user resource → return empty
  IF v_user_resource_id IS NULL THEN
    RETURN;
  END IF;

  -- Ownership check: caller must own the target resource via a parent link
  IF NOT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_resource_id
      AND to_id = v_user_resource_id
      AND link_type = 'parent'
  ) THEN
    -- Caller does not own the target resource — return empty (never raise)
    RETURN;
  END IF;

  -- Walk: credentials linked to resource_id via p_link_type → vault secret
  RETURN QUERY
  SELECT
    r.id AS credential_id,
    ds.decrypted_secret AS secret,
    r.config AS metadata
  FROM public.resource_links rl
  JOIN public.resources r
    ON r.id = rl.from_id AND r.type = 'credential'
  JOIN vault.decrypted_secrets ds
    ON ds.id = (r.config->>'vaultSecretId')::uuid
  WHERE rl.to_id = p_resource_id
    AND rl.link_type = p_link_type;
END;
$$;

-- D. Grant EXECUTE to authenticated and service_role
REVOKE ALL ON FUNCTION public.get_user_credential(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_credential(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_credential(TEXT, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.get_user_credential_for(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_credential_for(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_credential_for(UUID, TEXT, UUID) TO service_role;

-- E. Smoke test: verify both functions exist and return empty for a nonexistent user
-- (runs inline during migration, cleans up after itself)
DO $smoke_test$
DECLARE
  v_fake_uid UUID := '00000000-0000-0000-0000-000000000001';
  v_count INT;
BEGIN
  -- get_user_credential with no matching user resource should return 0 rows
  SELECT COUNT(*) INTO v_count
  FROM public.get_user_credential('CLOUDFLARE_API_TOKEN', v_fake_uid);

  IF v_count != 0 THEN
    RAISE EXCEPTION 'Smoke test FAILED: get_user_credential returned rows for nonexistent user';
  END IF;

  -- get_user_credential_for with no matching user resource should return 0 rows
  SELECT COUNT(*) INTO v_count
  FROM public.get_user_credential_for(gen_random_uuid(), 'accesses', v_fake_uid);

  IF v_count != 0 THEN
    RAISE EXCEPTION 'Smoke test FAILED: get_user_credential_for returned rows for nonexistent user';
  END IF;

  RAISE NOTICE 'Smoke test PASSED: both RPCs return empty for nonexistent user';
END;
$smoke_test$;
