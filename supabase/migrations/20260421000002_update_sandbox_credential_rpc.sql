-- Migration: sandbox_identity_tokens + update_sandbox_credential + register_sandbox_token
-- Story 1: Secure credential writeback using table-based token validation
--
-- Design: rather than JWT verification in PostgreSQL (which requires pgjwt extension
-- and complex base64url decoding), we use a token registry table. Application code
-- generates a cryptographically random token, stores its sha256 hash here, and passes
-- the plain token to the sandbox. The sandbox includes the token in credential writeback
-- requests; the RPC validates by hashing and comparing.

-- A. sandbox_identity_tokens — registry of active sandbox writeback tokens
CREATE TABLE IF NOT EXISTS public.sandbox_identity_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_id  UUID        NOT NULL,   -- references a server resource
  user_id     UUID        NOT NULL,   -- references a user resource (resources.id, type='user')
  token_hash  TEXT        NOT NULL,   -- sha256 hex-encoded hash of the plain token
  scope       TEXT        NOT NULL DEFAULT 'writeback_own_credentials',
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Uniqueness: one active token hash per scope (prevent hash collisions being exploited)
  CONSTRAINT uq_sandbox_identity_token_hash UNIQUE (token_hash)
);

-- Index for fast lookups by user_id (used in update_sandbox_credential ownership check)
CREATE INDEX IF NOT EXISTS idx_sandbox_identity_tokens_user_id
  ON public.sandbox_identity_tokens (user_id);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS idx_sandbox_identity_tokens_expires_at
  ON public.sandbox_identity_tokens (expires_at);

-- RLS: only service_role may read/write this table directly (token hashes are sensitive)
ALTER TABLE public.sandbox_identity_tokens ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT policies for authenticated — all access goes through SECURITY DEFINER RPCs

-- B. register_sandbox_token — application-facing helper to register a new token
--    Called by mint-sandbox-token.ts after generating the plain token.
DROP FUNCTION IF EXISTS public.register_sandbox_token(uuid, uuid, text, timestamptz);
CREATE OR REPLACE FUNCTION public.register_sandbox_token(
  p_sandbox_id UUID,
  p_user_id    UUID,
  p_token      TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_token_hash TEXT;
  v_id         UUID;
BEGIN
  -- Verify the user resource exists and is of type 'user'
  IF NOT EXISTS (
    SELECT 1 FROM public.resources WHERE id = p_user_id AND type = 'user'
  ) THEN
    RAISE EXCEPTION 'register_sandbox_token: user_id % does not reference a user resource', p_user_id;
  END IF;

  -- Verify the sandbox resource exists
  IF NOT EXISTS (
    SELECT 1 FROM public.resources WHERE id = p_sandbox_id
  ) THEN
    RAISE EXCEPTION 'register_sandbox_token: sandbox_id % does not reference a resource', p_sandbox_id;
  END IF;

  -- Compute sha256 hash of the plain token
  v_token_hash := encode(digest(p_token, 'sha256'), 'hex');

  -- Insert the token record (will fail on duplicate hash due to UNIQUE constraint)
  INSERT INTO public.sandbox_identity_tokens (sandbox_id, user_id, token_hash, expires_at)
  VALUES (p_sandbox_id, p_user_id, v_token_hash, p_expires_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- C. update_sandbox_credential — secure credential writeback
--    Validates a sandbox identity token, verifies credential ownership, updates vault secret.
DROP FUNCTION IF EXISTS public.update_sandbox_credential(uuid, text, text);
CREATE OR REPLACE FUNCTION public.update_sandbox_credential(
  p_credential_id UUID,
  p_new_value     TEXT,
  p_sandbox_token TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions, pg_catalog
AS $$
DECLARE
  v_token_hash  TEXT;
  v_token_row   public.sandbox_identity_tokens%ROWTYPE;
  v_vault_secret_id UUID;
BEGIN
  -- 1. Hash the incoming token
  v_token_hash := encode(digest(p_sandbox_token, 'sha256'), 'hex');

  -- 2. Look up the token record (validates hash, scope, and expiry atomically)
  SELECT * INTO v_token_row
  FROM public.sandbox_identity_tokens
  WHERE token_hash = v_token_hash
    AND scope = 'writeback_own_credentials'
    AND expires_at > now()
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_sandbox_credential: token invalid, expired, or wrong scope';
  END IF;

  -- 3. Verify the credential is owned by the token's user via 'parent' link
  --    The credential's parent must be a user resource matching token's user_id
  IF NOT EXISTS (
    SELECT 1
    FROM public.resources r
    JOIN public.resource_links rl
      ON rl.from_id = r.id AND rl.link_type = 'parent'
    WHERE r.id = p_credential_id
      AND r.type = 'credential'
      AND rl.to_id = v_token_row.user_id
  ) THEN
    RAISE EXCEPTION 'update_sandbox_credential: credential % is not owned by token user %',
      p_credential_id, v_token_row.user_id;
  END IF;

  -- 4. Retrieve the vault secret ID from the credential's config
  SELECT (config->>'vaultSecretId')::uuid INTO v_vault_secret_id
  FROM public.resources
  WHERE id = p_credential_id AND type = 'credential';

  IF v_vault_secret_id IS NULL THEN
    RAISE EXCEPTION 'update_sandbox_credential: credential % has no vaultSecretId in config', p_credential_id;
  END IF;

  -- 5. Update the vault secret (vault.update_secret if available, else direct UPDATE)
  --    vault.update_secret(secret_id, new_secret, new_name, new_description) — standard Supabase Vault API
  PERFORM vault.update_secret(v_vault_secret_id, p_new_value);

  RETURN TRUE;
END;
$$;

-- D. Grant execute permissions
REVOKE ALL ON FUNCTION public.register_sandbox_token(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_sandbox_token(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
-- authenticated users cannot call register_sandbox_token — only service_role (application backend)

REVOKE ALL ON FUNCTION public.update_sandbox_credential(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_sandbox_credential(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_sandbox_credential(UUID, TEXT, TEXT) TO service_role;

-- E. Smoke test: verify both functions exist and table was created
DO $smoke_test$
DECLARE
  v_table_exists BOOLEAN;
  v_fn1_exists   BOOLEAN;
  v_fn2_exists   BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sandbox_identity_tokens'
  ) INTO v_table_exists;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'register_sandbox_token'
  ) INTO v_fn1_exists;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'update_sandbox_credential'
  ) INTO v_fn2_exists;

  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: sandbox_identity_tokens table not found';
  END IF;
  IF NOT v_fn1_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: register_sandbox_token function not found';
  END IF;
  IF NOT v_fn2_exists THEN
    RAISE EXCEPTION 'Smoke test FAILED: update_sandbox_credential function not found';
  END IF;

  RAISE NOTICE 'Smoke test PASSED: sandbox_identity_tokens table + both RPCs exist';
END;
$smoke_test$;
