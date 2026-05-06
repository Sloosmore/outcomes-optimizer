-- =============================================================================
-- BASELINE MIGRATION: Full schema snapshot as of 2026-03-17
-- =============================================================================
-- This migration captures the complete production schema. It is fully idempotent:
-- - IF NOT EXISTS for all CREATE TABLE/INDEX
-- - ON CONFLICT DO NOTHING for seed data
-- On production: complete no-op (everything already exists).
-- On fresh branches: creates the full schema from scratch.
-- =============================================================================

-- ── 1. Independent tables (no FK dependencies) ─────────────────────────────

CREATE TABLE IF NOT EXISTS traces (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text        NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz,
  file_path  text        NOT NULL,
  cost       numeric,
  duration_ms numeric
);

CREATE TABLE IF NOT EXISTS resources (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE,
  type         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active',
  config       jsonb       DEFAULT '{}'::jsonb,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  notes        text,
  locked_by    text,
  locked_at    timestamptz,
  auth_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_types (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL UNIQUE,
  description   text        NOT NULL,
  config_schema jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finite        boolean     NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS link_types (
  name        text        PRIMARY KEY,
  description text        NOT NULL,
  cardinality text        NOT NULL DEFAULT 'many-to-many',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS value_types (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  base_type   text        NOT NULL,
  constraints jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS logs (
  id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  level     text        NOT NULL,
  service   text        NOT NULL,
  message   text        NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  data      jsonb,
  error     jsonb
);

CREATE TABLE IF NOT EXISTS agent_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id   uuid        NOT NULL,
  process_name text        NOT NULL,
  resource_id  uuid        NOT NULL,
  source       text        NOT NULL,
  payload      jsonb,
  ts           timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Tables with single-level FK dependencies ────────────────────────────

CREATE TABLE IF NOT EXISTS tag_entities (
  entity_id   uuid NOT NULL,
  entity_type text NOT NULL,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, entity_type, tag_id)
);

CREATE TABLE IF NOT EXISTS resource_type_properties (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text        NOT NULL REFERENCES resource_types(name) ON DELETE CASCADE,
  field_name    text        NOT NULL,
  value_type_id uuid        REFERENCES value_types(id) ON DELETE SET NULL,
  required      boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, field_name)
);

CREATE TABLE IF NOT EXISTS link_type_rules (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  link_type  text        NOT NULL REFERENCES link_types(name) ON DELETE CASCADE,
  from_type  text        REFERENCES resource_types(name) ON DELETE CASCADE,
  to_type    text        REFERENCES resource_types(name) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  min_count  integer     NOT NULL DEFAULT 0,
  max_count  integer,
  CONSTRAINT uq_link_type_rules UNIQUE NULLS NOT DISTINCT (link_type, from_type, to_type)
);

CREATE TABLE IF NOT EXISTS processes (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  status               text        NOT NULL DEFAULT 'pending',
  current_epoch        integer     NOT NULL DEFAULT 0,
  metrics              jsonb,
  parent_campaign_id   uuid        REFERENCES processes(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  resource_ids         uuid[],
  branch               text,
  metrics_schema       jsonb,
  run_type             text,
  pr_url               text,
  training_resource_id uuid        REFERENCES resources(id),
  skill_resource_id    uuid        REFERENCES resources(id) ON DELETE RESTRICT,
  channel_id           uuid        UNIQUE,
  resume_at            timestamptz,
  resume_context       text,
  worktree_path        text,
  goal_resource_id     uuid        REFERENCES resources(id) ON DELETE RESTRICT,
  CONSTRAINT processes_status_check
    CHECK (status IN ('pending','active','paused','waiting','completed','failed')),
  CONSTRAINT campaigns_run_type_check
    CHECK (run_type IS NULL OR run_type IN ('cloud','local','moltbot'))
);

-- ── 3. Tables with two-level FK dependencies ───────────────────────────────

CREATE TABLE IF NOT EXISTS epoch_results (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid        NOT NULL REFERENCES processes(id),
  epoch_number    integer     NOT NULL,
  workflow_run_id text,
  session_id      text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  duration_ms     numeric,
  cost            numeric,
  status          text        NOT NULL DEFAULT 'in_progress',
  metrics         jsonb,
  epoch_debrief   text
);

CREATE TABLE IF NOT EXISTS process_dependencies (
  process_id    uuid        NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  dependency_id uuid        NOT NULL REFERENCES processes(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (process_id, dependency_id),
  CHECK (process_id != dependency_id)
);

CREATE TABLE IF NOT EXISTS resource_links (
  from_id    uuid        NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  to_id      uuid        NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  link_type  text        NOT NULL DEFAULT 'parent' REFERENCES link_types(name) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, link_type),
  CHECK (from_id != to_id)
);

CREATE TABLE IF NOT EXISTS cron_executions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_resource_id uuid        REFERENCES resources(id) ON DELETE CASCADE,
  process_id       uuid        REFERENCES processes(id) ON DELETE SET NULL,
  status           text        NOT NULL CHECK (status IN ('dispatched','failed')),
  error            text,
  executed_at      timestamptz NOT NULL DEFAULT now()
);

-- ── 4. Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS resources_type_idx   ON resources USING btree (type);
CREATE INDEX IF NOT EXISTS resources_status_idx ON resources USING btree (status);

CREATE INDEX IF NOT EXISTS tag_entities_tag_id_idx ON tag_entities USING btree (tag_id);

CREATE INDEX IF NOT EXISTS processes_status_idx          ON processes USING btree (status);
CREATE INDEX IF NOT EXISTS processes_skill_resource_idx  ON processes USING btree (skill_resource_id);
CREATE INDEX IF NOT EXISTS processes_resume_at_idx       ON processes USING btree (resume_at);

CREATE UNIQUE INDEX IF NOT EXISTS epoch_results_campaign_epoch_idx
  ON epoch_results USING btree (campaign_id, epoch_number);
CREATE INDEX IF NOT EXISTS epoch_results_workflow_run_idx
  ON epoch_results USING btree (workflow_run_id);

CREATE INDEX IF NOT EXISTS idx_process_dependencies_dependency_id
  ON process_dependencies USING btree (dependency_id);

CREATE INDEX IF NOT EXISTS idx_resource_links_to_id     ON resource_links USING btree (to_id);
CREATE INDEX IF NOT EXISTS idx_resource_links_link_type  ON resource_links USING btree (link_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_links_runsas
  ON resource_links (from_id) WHERE link_type = 'runsAs';
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_links_hostedon
  ON resource_links (from_id) WHERE link_type = 'hostedOn';
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_links_partof
  ON resource_links (from_id) WHERE link_type = 'partOf';

CREATE INDEX IF NOT EXISTS idx_agent_events_ts         ON agent_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_process_id ON agent_events (process_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cron_executions_per_minute
  ON cron_executions (cron_resource_id, date_trunc('minute', executed_at AT TIME ZONE 'UTC'));

CREATE INDEX IF NOT EXISTS logs_level_idx     ON logs USING btree (level);
CREATE INDEX IF NOT EXISTS logs_service_idx   ON logs USING btree (service);
CREATE INDEX IF NOT EXISTS logs_timestamp_idx ON logs USING btree (timestamp);

-- ── 5. Trigger function + trigger ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION check_dependency_cycle()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT dependency_id AS node, 1 AS depth
      FROM process_dependencies
      WHERE process_id = NEW.dependency_id
      UNION ALL
      SELECT pd.dependency_id, a.depth + 1
      FROM process_dependencies pd
      JOIN ancestors a ON pd.process_id = a.node
      WHERE a.depth < 100
    )
    SELECT 1 FROM ancestors WHERE node = NEW.process_id
  ) THEN
    RAISE EXCEPTION 'Dependency cycle detected: % -> %', NEW.process_id::text, NEW.dependency_id::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_dependency_cycle ON process_dependencies;
CREATE TRIGGER prevent_dependency_cycle
  BEFORE INSERT OR UPDATE ON process_dependencies
  FOR EACH ROW EXECUTE FUNCTION check_dependency_cycle();

-- ── 6. Row-Level Security ──────────────────────────────────────────────────

-- Standard service_role pattern for most tables
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'traces', 'resources', 'tags', 'tag_entities', 'resource_types', 'link_types',
    'link_type_rules', 'value_types', 'resource_type_properties', 'processes',
    'epoch_results', 'logs', 'process_dependencies', 'resource_links',
    'cron_executions'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "service_role_full_access" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "service_role_full_access" ON public.%I '
      'AS PERMISSIVE FOR ALL TO service_role '
      'USING (true) '
      'WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;

-- agent_events: full service_role access (consistent with all other tables)
ALTER TABLE public.agent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_insert_agent_events" ON public.agent_events;
DROP POLICY IF EXISTS "service_delete_agent_events" ON public.agent_events;
DROP POLICY IF EXISTS "service_role_full_access" ON public.agent_events;
CREATE POLICY "service_role_full_access" ON public.agent_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 7. Seed data ───────────────────────────────────────────────────────────

INSERT INTO resource_types (name, description, finite, config_schema) VALUES
  ('app',        'Platform applications that own identities (e.g. Meta app, Google project)',  true,  NULL),
  ('bucket',     'Object storage buckets (R2, S3, Hetzner Object Storage)',                    false, NULL),
  ('config',     'Arbitrary configuration objects — freeform key/value stores',                false, NULL),
  ('credential', 'Secrets and tokens that grant access to other resources',                    true,  NULL),
  ('cron',       'Scheduled execution triggers linked to goal resources',                      false, '{"schedule":{"type":"string"},"enabled":{"type":"boolean"},"prompt":{"type":"string"}}'::jsonb),
  ('data',       'Storage assets agents operate on — files, datasets, media',                  false, NULL),
  ('database',   'Managed database instances',                                                 true,  NULL),
  ('deployment', 'Running service instances (Cloudflare Workers, processes)',                   false, NULL),
  ('identity',   'Platform accounts and handles agents act as',                                true,  NULL),
  ('proxy',      'Egress IP addresses agents route outbound calls through',                    true,  NULL),
  ('runtime',    'A runtime environment',                                                      false, NULL),
  ('server',     'Physical or virtual compute nodes (VPS, bare metal)',                         true,  NULL),
  ('skill',      'Agent capabilities installable from version-controlled references',          false, NULL),
  ('url',        'External endpoints agents call — APIs, webhooks, services',                  false, NULL),
  ('access-code','Single-use invitation codes for user onboarding',                            false, NULL),
  ('agent',      'AI agent capabilities that run skills',                                      false, NULL),
  ('project',    'Project namespace that groups user resources and processes',                  false, NULL),
  ('user',       'Platform user identity resource provisioned on sign-up',                     false, NULL)
ON CONFLICT (name) DO NOTHING;

INSERT INTO link_types (name, description, cardinality) VALUES
  ('credential',     'Resource authenticates via this credential',                                                        'many-to-one'),
  ('dependsOn',      'This resource cannot start or proceed until the target resource is complete',                        'many-to-many'),
  ('grants',         'App grants platform permissions or access to this identity',                                         'many-to-many'),
  ('hostedOn',       'Resource is hosted on or runs within this infrastructure node',                                     'many-to-one'),
  ('parent',         '[DEPRECATED: use hostedOn, partOf, or dependsOn] Resource belongs to a parent resource',            'many-to-one'),
  ('partOf',         'Resource is a component or sub-resource of this parent application',                                'many-to-one'),
  ('proxy',          'Resource egresses through this proxy',                                                               'many-to-one'),
  ('registeredWith', 'Resource was registered/created using this identity and is recoverable through it',                  'many-to-one'),
  ('runsAs',         'Deployment authenticates and runs as this identity',                                                 'many-to-one'),
  ('schedules',      'Cron resource schedules execution of a goal resource',                                               'many-to-one')
ON CONFLICT (name) DO NOTHING;

INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count) VALUES
  ('credential',     'identity',   'credential', 1,    1),
  ('credential',     'server',     'credential', 0,    NULL),
  ('grants',         'app',        'identity',   0,    NULL),
  ('hostedOn',       'runtime',    'server',     0,    NULL),
  ('hostedOn',       NULL,         'server',     0,    NULL),
  ('parent',         'bucket',     'app',        0,    NULL),
  ('parent',         'database',   'app',        0,    NULL),
  ('parent',         'deployment', 'app',        0,    NULL),
  ('parent',         'deployment', 'server',     0,    NULL),
  ('parent',         'identity',   'app',        0,    NULL),
  ('parent',         'identity',   'identity',   0,    NULL),
  ('parent',         'server',     'app',        0,    NULL),
  ('partOf',         NULL,         'app',        0,    NULL),
  ('proxy',          'identity',   'proxy',      0,    1),
  ('registeredWith', 'app',        'app',        0,    NULL),
  ('registeredWith', 'app',        'identity',   0,    NULL),
  ('registeredWith', 'identity',   'identity',   0,    NULL),
  ('registeredWith', 'proxy',      'identity',   0,    NULL),
  ('runsAs',         'deployment', 'identity',   0,    NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

INSERT INTO value_types (name, base_type, constraints) VALUES
  ('url',              'string',  '[{"type":"regex","pattern":"^https?://"}]'::jsonb),
  ('non-empty-string', 'string',  '[{"type":"range","min":1}]'::jsonb),
  ('uuid',             'string',  '[{"type":"uuid"}]'::jsonb),
  ('positive-integer', 'integer', '[{"type":"range","min":1}]'::jsonb),
  ('inject-strategy',  'string',  '[{"type":"enum","values":["bearer","header","supabase","oauth2-refresh","query-param","key-prefix"]}]'::jsonb)
ON CONFLICT (name) DO NOTHING;

INSERT INTO resource_type_properties (resource_type, field_name, value_type_id, required)
SELECT 'identity', 'handle', id, true FROM value_types WHERE name = 'non-empty-string'
ON CONFLICT (resource_type, field_name) DO NOTHING;

INSERT INTO resource_type_properties (resource_type, field_name, value_type_id, required)
SELECT 'proxy', 'url', id, true FROM value_types WHERE name = 'url'
ON CONFLICT (resource_type, field_name) DO NOTHING;

INSERT INTO resource_type_properties (resource_type, field_name, value_type_id, required)
SELECT 'credential', 'dopplerProject', id, true FROM value_types WHERE name = 'non-empty-string'
ON CONFLICT (resource_type, field_name) DO NOTHING;

-- ── 8. Realtime ────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'agent_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE agent_events;
  END IF;
END $$;

ALTER TABLE agent_events REPLICA IDENTITY FULL;
