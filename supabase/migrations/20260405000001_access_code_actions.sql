-- Access Code Actions: create_access_code + redeem_access_code
-- 1. Register access-code resource type
-- 2. Register redeemed_by link type + rule
-- 3. Partial unique index on resources(name) for access-code type
-- 4. create_access_code() RPC — generates a code, creates resource
-- 5. redeem_access_code() RPC — validates, flips status, links user
-- 6. action_types entries for both

-- ── 1. Register access-code resource type ──────────────────────────────────
INSERT INTO public.resource_types (name, description, finite) VALUES
  ('access-code', 'Single-use invitation codes for user onboarding', false)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Register redeemed_by link type + rule ──────────────────────────────
-- link_type_rules.link_type is a FK → link_types(name); must insert there first.
INSERT INTO public.link_types (name, description, cardinality) VALUES
  ('redeemed_by', 'User redeemed this access code', 'many-to-one')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.link_type_rules (link_type, from_type, to_type, min_count, max_count) VALUES
  ('redeemed_by', 'user', 'access-code', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- ── 3. Partial unique index for access-code name uniqueness ───────────────
-- The global UNIQUE(name) on resources was dropped in migration 0013.
-- This index enforces uniqueness within the access-code type and enables
-- fast name-based lookups in both RPCs below.
CREATE UNIQUE INDEX IF NOT EXISTS resources_name_access_code_uniq
  ON public.resources(name) WHERE type = 'access-code';

-- ── 4. create_access_code() RPC ───────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_access_code(text, jsonb);
CREATE OR REPLACE FUNCTION public.create_access_code(
  p_code    TEXT DEFAULT NULL,
  p_config  JSONB DEFAULT '{}'
)
RETURNS TABLE(access_code_id UUID, code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id   UUID;
  v_code TEXT;
BEGIN
  -- Generate code if not provided (8-char hex uppercase from UUID)
  IF p_code IS NULL OR p_code = '' THEN
    v_code := upper(replace(left(gen_random_uuid()::text, 8), '-', ''));
  ELSE
    v_code := p_code;
  END IF;

  -- Validate code format: alphanumeric, 4-32 chars
  IF v_code !~ '^[A-Za-z0-9_-]{4,32}$' THEN
    RAISE EXCEPTION 'Invalid access code format: must be 4-32 alphanumeric characters'
      USING ERRCODE = '22023';
  END IF;

  -- Check uniqueness
  IF EXISTS (SELECT 1 FROM public.resources WHERE name = v_code AND type = 'access-code') THEN
    RAISE EXCEPTION 'Access code already exists: %', v_code
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (gen_random_uuid(), v_code, 'access-code', 'active', COALESCE(p_config, '{}'))
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_access_code(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_access_code(TEXT, JSONB) TO service_role;

-- ── 5. redeem_access_code() RPC ───────────────────────────────────────────
DROP FUNCTION IF EXISTS public.redeem_access_code(text, uuid);
CREATE OR REPLACE FUNCTION public.redeem_access_code(
  p_code    TEXT,
  p_user_id UUID
)
RETURNS TABLE(access_code_id UUID, redeemed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_code_id     UUID;
  v_code_status TEXT;
  v_user_type   TEXT;
  v_updated     INTEGER;
BEGIN
  -- Validate user resource exists and is type=user
  SELECT type INTO v_user_type FROM public.resources WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User resource not found: %', p_user_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_user_type != 'user' THEN
    RAISE EXCEPTION 'Resource % is type=%, expected user', p_user_id, v_user_type
      USING ERRCODE = '22023';
  END IF;

  -- Look up the access code
  SELECT id, status INTO v_code_id, v_code_status
  FROM public.resources
  WHERE name = p_code AND type = 'access-code'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access code not found: %', p_code
      USING ERRCODE = 'P0002';
  END IF;

  IF v_code_status != 'active' THEN
    RAISE EXCEPTION 'Access code is not active (status: %)', v_code_status
      USING ERRCODE = '22023';
  END IF;

  -- Flip status to used
  UPDATE public.resources
  SET status = 'used', updated_at = now()
  WHERE id = v_code_id AND status = 'active';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    -- Race condition: someone else redeemed it between SELECT and UPDATE
    RAISE EXCEPTION 'Access code was already redeemed (race condition)'
      USING ERRCODE = '23505';
  END IF;

  -- Link user → access-code via redeemed_by
  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_user_id, v_code_id, 'redeemed_by')
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT v_code_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_access_code(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_access_code(TEXT, UUID) TO service_role;

-- ── 6. action_types entries ───────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_access_code',
    'create_access_code',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "code":   { "type": "string", "pattern": "^[A-Za-z0-9_-]{4,32}$" },
        "config": { "type": "object" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["accessCodeId", "code"],
      "properties": {
        "accessCodeId": { "type": "string" },
        "code":         { "type": "string" }
      }
    }'::jsonb,
    '{"code": "p_code", "config": "p_config"}'::jsonb,
    '{"access_code_id": "accessCodeId", "code": "code"}'::jsonb,
    'Creates a new access code for user onboarding. Auto-generates an 8-char hex code if none provided.',
    'null'::jsonb
  ),
  (
    'redeem_access_code',
    'redeem_access_code',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["code", "userId"],
      "properties": {
        "code":   { "type": "string", "minLength": 1 },
        "userId": { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["accessCodeId", "redeemed"],
      "properties": {
        "accessCodeId": { "type": "string" },
        "redeemed":     { "type": "boolean" }
      }
    }'::jsonb,
    '{"code": "p_code", "userId": "p_user_id"}'::jsonb,
    '{"access_code_id": "accessCodeId", "redeemed": "redeemed"}'::jsonb,
    'Redeems an active access code: flips status to used, links user via redeemed_by. Fails if code is invalid or already used.',
    'null'::jsonb
  )
ON CONFLICT (name) DO UPDATE SET
  rpc_function     = EXCLUDED.rpc_function,
  input_schema     = EXCLUDED.input_schema,
  output_schema    = EXCLUDED.output_schema,
  param_mapping    = EXCLUDED.param_mapping,
  result_mapping   = EXCLUDED.result_mapping,
  description      = EXCLUDED.description,
  validation_rules = EXCLUDED.validation_rules;

-- ── 7. Extend status vocabulary to include 'used' ─────────────────────────
-- redeem_access_code sets status='used' to mark redeemed codes. Without this
-- change, update_resource_status() rejects 'used' and the action_types schema
-- blocks it, making redeemed codes unmanageable through the standard graph API.
DROP FUNCTION IF EXISTS public.update_resource_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.update_resource_status(
  p_resource_id     UUID,
  p_new_status      TEXT,
  p_expected_status TEXT DEFAULT NULL
)
RETURNS TABLE(resource_id UUID, old_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_current_status TEXT;
  v_id             UUID;
BEGIN
  -- Validate new status (extended to include 'used' for single-use resources)
  IF p_new_status NOT IN ('active', 'inactive', 'banned', 'expired', 'error', 'used') THEN
    RAISE EXCEPTION 'Invalid status: must be one of active, inactive, banned, expired, error, used'
      USING ERRCODE = '22023';
  END IF;

  -- Get current resource (FOR UPDATE prevents lost-update on concurrent status changes)
  SELECT id, status INTO v_id, v_current_status
  FROM public.resources
  WHERE id = p_resource_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Check expected status (optimistic concurrency)
  IF p_expected_status IS NOT NULL AND v_current_status <> p_expected_status THEN
    RAISE EXCEPTION 'Status conflict: expected % but found %', p_expected_status, v_current_status
      USING ERRCODE = '22023';
  END IF;

  -- Update status
  UPDATE public.resources
  SET status = p_new_status, updated_at = now()
  WHERE id = p_resource_id;

  RETURN QUERY SELECT p_resource_id, v_current_status;
END;
$$;

-- Update action_types schema to accept 'used' in status enums
UPDATE public.action_types
SET input_schema = jsonb_set(
      jsonb_set(
        input_schema,
        '{properties,newStatus,enum}',
        '["active","inactive","banned","expired","error","used"]'::jsonb
      ),
      '{properties,expectedStatus,enum}',
      '["active","inactive","banned","expired","error","used"]'::jsonb
    )
WHERE name = 'update_resource_status';
