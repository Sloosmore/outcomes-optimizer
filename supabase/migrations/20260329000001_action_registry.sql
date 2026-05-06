-- ── Action Registry Migration ──────────────────────────────────────────────
-- Story 1: DB-Driven Action Registry
-- Creates action_types (registry) and action_events (audit log) tables.

-- ── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.action_types (
  name            text        PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]+$'),
  rpc_function    text        NOT NULL CHECK (rpc_function ~ '^[a-z][a-z0-9_]+$'),
  input_schema    jsonb       NOT NULL,
  output_schema   jsonb       NOT NULL,
  param_mapping   jsonb       NOT NULL,
  result_mapping  jsonb       NOT NULL,
  description     text,
  schema_version  integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- action_events is append-only. No retention policy or partitioning is defined here.
-- Before GA, add a pg_cron purge job or pg_partman monthly partitioning strategy.
CREATE TABLE IF NOT EXISTS public.action_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type     text        NOT NULL REFERENCES public.action_types(name),
  input           jsonb       NOT NULL,
  output          jsonb,
  status          text        NOT NULL CHECK (status IN ('success', 'failed')),
  error           text,
  actor_id        uuid,
  schema_version  integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS action_events_action_type_idx  ON public.action_events (action_type);
CREATE INDEX IF NOT EXISTS action_events_actor_id_idx     ON public.action_events (actor_id);
CREATE INDEX IF NOT EXISTS action_events_created_at_idx   ON public.action_events (created_at DESC);

-- ── 3. Row-Level Security ───────────────────────────────────────────────────

-- action_types: service_role full access, authenticated SELECT
ALTER TABLE public.action_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON public.action_types;
CREATE POLICY "service_role_full_access" ON public.action_types
  AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_select" ON public.action_types;
CREATE POLICY "authenticated_select" ON public.action_types
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

-- action_events: service_role full access, authenticated SELECT own rows only (no INSERT)
ALTER TABLE public.action_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON public.action_events;
CREATE POLICY "service_role_full_access" ON public.action_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_select_own" ON public.action_events;
CREATE POLICY "authenticated_select_own" ON public.action_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (actor_id = auth.uid());

-- ── 4. Seed Data ────────────────────────────────────────────────────────────

INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description)
VALUES
  (
    'provision_user',
    'provision_user',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["authUserId", "email"],
      "properties": {
        "authUserId": { "type": "string", "description": "UUID of the auth user" },
        "email": { "type": "string", "format": "email" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["userResourceId", "projectResourceId"],
      "properties": {
        "userResourceId": { "type": "string" },
        "projectResourceId": { "type": "string" }
      }
    }'::jsonb,
    '{"authUserId": "p_auth_user_id", "email": "p_email"}'::jsonb,
    '{"user_resource_id": "userResourceId", "project_resource_id": "projectResourceId"}'::jsonb,
    'Provisions a new user resource and default project in the ontology'
  ),
  (
    'provision_sandbox',
    'provision_sandbox',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["userResourceId", "serverName", "sshKeyName", "publicKey"],
      "properties": {
        "userResourceId": { "type": "string", "description": "UUID of the user resource" },
        "serverName": { "type": "string" },
        "sshKeyName": { "type": "string" },
        "publicKey": { "type": "string" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["serverResourceId", "credentialResourceId", "isNew"],
      "properties": {
        "serverResourceId": { "type": "string" },
        "credentialResourceId": { "type": "string" },
        "isNew": { "type": "boolean" }
      }
    }'::jsonb,
    '{"userResourceId": "p_user_resource_id", "serverName": "p_server_name", "sshKeyName": "p_ssh_key_name", "publicKey": "p_public_key"}'::jsonb,
    '{"server_resource_id": "serverResourceId", "credential_resource_id": "credentialResourceId", "is_new": "isNew"}'::jsonb,
    'Provisions a new sandbox server resource with idempotent ON CONFLICT handling'
  ),
  (
    'update_sandbox_status',
    'update_sandbox_status',
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "required": ["serverResourceId", "status", "ip", "hetznerServerId", "provisionedAt"],
      "properties": {
        "serverResourceId": { "type": "string", "description": "UUID of the server resource" },
        "status": { "type": "string" },
        "ip": { "type": "string" },
        "hetznerServerId": { "type": "string" },
        "provisionedAt": { "type": "string", "format": "date-time" }
      },
      "additionalProperties": false
    }'::jsonb,
    '{
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    }'::jsonb,
    '{"serverResourceId": "p_server_resource_id", "status": "p_status", "ip": "p_ip", "hetznerServerId": "p_hetzner_server_id", "provisionedAt": "p_provisioned_at"}'::jsonb,
    '{}'::jsonb,
    'Updates sandbox server status with IP, hetzner server ID, and provisioned timestamp'
  )
ON CONFLICT (name) DO UPDATE SET
  rpc_function   = EXCLUDED.rpc_function,
  input_schema   = EXCLUDED.input_schema,
  output_schema  = EXCLUDED.output_schema,
  param_mapping  = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description    = EXCLUDED.description;
