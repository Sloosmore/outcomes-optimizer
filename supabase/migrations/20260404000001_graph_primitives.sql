-- Story 1: Graph Primitive RPCs + Schema Additions
-- 1. Add missing resource_types: project, user
-- 2. Add missing link_type: member_of
-- 3. Add missing link_type_rule: partOf NULL→project
-- 4. Five graph primitive RPCs: create_resource, delete_resource, create_link, delete_link, update_resource_status
-- 5. action_types rows for all 5 actions

-- ── 1. Schema prerequisites ────────────────────────────────────────────────

-- resource_types: add project and user (used in production but absent from baseline seed)
INSERT INTO public.resource_types (name, description, finite) VALUES
  ('project', 'Project namespace that groups user resources and processes', false),
  ('user',    'Platform user identity resource provisioned on sign-up',     false)
ON CONFLICT (name) DO NOTHING;

-- link_types: add member_of (used by provision_user but absent from baseline seed)
INSERT INTO public.link_types (name, description, cardinality) VALUES
  ('member_of', 'User is a member of this project', 'many-to-many')
ON CONFLICT (name) DO NOTHING;

-- link_type_rules: add partOf NULL→project and member_of user→project
INSERT INTO public.link_type_rules (link_type, from_type, to_type, min_count, max_count) VALUES
  ('partOf', NULL, 'project', 0, NULL),
  ('member_of', 'user', 'project', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- ── 2. create_resource() RPC ───────────────────────────────────────────────
-- create_resource dropped — see migration 20260407000007_drop_create_resource_create_link.sql
SELECT 1;

-- ── 3. delete_resource() RPC ───────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.delete_resource(uuid);
CREATE OR REPLACE FUNCTION public.delete_resource(
  p_resource_id UUID
)
RETURNS TABLE(deleted_links INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_locked_by TEXT;
  v_link_count INTEGER;
BEGIN
  -- Validate resource exists and check lock (FOR UPDATE prevents concurrent delete+lock races)
  SELECT locked_by INTO v_locked_by
  FROM public.resources
  WHERE id = p_resource_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource not found: %', p_resource_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_locked_by IS NOT NULL THEN
    RAISE EXCEPTION 'Resource is locked'
      USING ERRCODE = '55P03';
  END IF;

  -- Delete all resource links and count them
  WITH deleted AS (
    DELETE FROM public.resource_links
    WHERE from_id = p_resource_id OR to_id = p_resource_id
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_link_count FROM deleted;

  -- Delete the resource
  DELETE FROM public.resources WHERE id = p_resource_id;

  RETURN QUERY SELECT v_link_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_resource(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_resource(UUID) TO service_role;

-- ── 4. create_link() RPC ───────────────────────────────────────────────────
-- create_link dropped — see migration 20260407000007_drop_create_resource_create_link.sql
SELECT 1;

-- ── 5. delete_link() RPC ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.delete_link(uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.delete_link(
  p_from_id   UUID,
  p_to_id     UUID,
  p_link_type TEXT
)
RETURNS TABLE(deleted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_min_count  INTEGER;
  v_cur_count  INTEGER;
  v_link_exists BOOLEAN;
BEGIN
  -- Lock the from resource to serialize concurrent delete+count races
  PERFORM 1 FROM public.resources WHERE id = p_from_id FOR UPDATE;

  -- Check if link exists
  SELECT EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = p_link_type
  ) INTO v_link_exists;

  IF NOT v_link_exists THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  -- Check min_count constraint
  SELECT min_count INTO v_min_count
  FROM public.link_type_rules
  WHERE link_type = p_link_type
    AND (from_type IS NULL OR from_type = (SELECT type FROM public.resources WHERE id = p_from_id))
    AND (to_type   IS NULL OR to_type   = (SELECT type FROM public.resources WHERE id = p_to_id))
  LIMIT 1;

  IF v_min_count IS NOT NULL AND v_min_count > 0 THEN
    SELECT count(*)::integer INTO v_cur_count
    FROM public.resource_links
    WHERE from_id = p_from_id AND link_type = p_link_type;

    IF v_cur_count <= v_min_count THEN
      RAISE EXCEPTION 'Cannot delete link: would go below min_count (%) for link type % from resource %', v_min_count, p_link_type, p_from_id
        USING ERRCODE = '23505';
    END IF;
  END IF;

  -- Delete the link
  DELETE FROM public.resource_links
  WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = p_link_type;

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_link(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_link(UUID, UUID, TEXT) TO service_role;

-- ── 6. update_resource_status() RPC ───────────────────────────────────────
DROP FUNCTION IF EXISTS public.update_resource_status(uuid, text, text);
CREATE OR REPLACE FUNCTION public.update_resource_status(
  p_resource_id    UUID,
  p_new_status     TEXT,
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
  -- Validate new status
  IF p_new_status NOT IN ('active', 'inactive', 'banned', 'expired', 'error') THEN
    RAISE EXCEPTION 'Invalid status: must be one of active, inactive, banned, expired, error'
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

REVOKE ALL ON FUNCTION public.update_resource_status(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_resource_status(UUID, TEXT, TEXT) TO service_role;

-- ── 7. action_types seed data ──────────────────────────────────────────────
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description, validation_rules)
VALUES
  (
    'create_resource',
    'create_resource',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["name", "type"],
      "properties": {
        "name":   { "type": "string", "minLength": 1, "maxLength": 128 },
        "type":   { "type": "string", "minLength": 1 },
        "status": { "type": "string", "enum": ["active", "inactive", "banned", "expired", "error"] },
        "config": { "type": "object" },
        "notes":  { "type": "string" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["resourceId"],
      "properties": {
        "resourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"name": "p_name", "type": "p_type", "status": "p_status", "config": "p_config", "notes": "p_notes"}'::jsonb,
    '{"resource_id": "resourceId"}'::jsonb,
    'Creates a new resource of the specified type',
    '{
      "uniqueness": [
        {
          "table": "resources",
          "field": "name",
          "input_field": "name",
          "error": "A resource with this name already exists",
          "on_conflict": "error"
        }
      ]
    }'::jsonb
  ),
  (
    'delete_resource',
    'delete_resource',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId"],
      "properties": {
        "resourceId": { "type": "string", "format": "uuid" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["deletedLinks"],
      "properties": {
        "deletedLinks": { "type": "integer" }
      }
    }'::jsonb,
    '{"resourceId": "p_resource_id"}'::jsonb,
    '{"deleted_links": "deletedLinks"}'::jsonb,
    'Deletes a resource and all its links; fails if the resource is locked',
    'null'::jsonb
  ),
  (
    'create_link',
    'create_link',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["fromId", "toId", "linkType"],
      "properties": {
        "fromId":   { "type": "string", "format": "uuid" },
        "toId":     { "type": "string", "format": "uuid" },
        "linkType": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["created"],
      "properties": {
        "created": { "type": "boolean" }
      }
    }'::jsonb,
    '{"fromId": "p_from_id", "toId": "p_to_id", "linkType": "p_link_type"}'::jsonb,
    '{"created": "created"}'::jsonb,
    'Creates a directed link between two resources; validates link_type_rules',
    'null'::jsonb
  ),
  (
    'delete_link',
    'delete_link',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["fromId", "toId", "linkType"],
      "properties": {
        "fromId":   { "type": "string", "format": "uuid" },
        "toId":     { "type": "string", "format": "uuid" },
        "linkType": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["deleted"],
      "properties": {
        "deleted": { "type": "boolean" }
      }
    }'::jsonb,
    '{"fromId": "p_from_id", "toId": "p_to_id", "linkType": "p_link_type"}'::jsonb,
    '{"deleted": "deleted"}'::jsonb,
    'Deletes a directed link between two resources; enforces min_count constraints',
    'null'::jsonb
  ),
  (
    'update_resource_status',
    'update_resource_status',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["resourceId", "newStatus"],
      "properties": {
        "resourceId":      { "type": "string", "format": "uuid" },
        "newStatus":       { "type": "string", "enum": ["active", "inactive", "banned", "expired", "error"] },
        "expectedStatus":  { "type": "string", "enum": ["active", "inactive", "banned", "expired", "error"] }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "type": "object",
      "required": ["resourceId", "oldStatus"],
      "properties": {
        "resourceId": { "type": "string" },
        "oldStatus":  { "type": "string" }
      }
    }'::jsonb,
    '{"resourceId": "p_resource_id", "newStatus": "p_new_status", "expectedStatus": "p_expected_status"}'::jsonb,
    '{"resource_id": "resourceId", "old_status": "oldStatus"}'::jsonb,
    'Updates a resource status with optional optimistic concurrency check via expectedStatus',
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
