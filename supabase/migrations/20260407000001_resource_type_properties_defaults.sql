-- Migration: Add default_value column to resource_type_properties and seed all property defaults
-- Idempotent: uses IF NOT EXISTS for ALTER TABLE, ON CONFLICT DO UPDATE for inserts

-- Step 1: Add default_value JSONB column (nullable)
ALTER TABLE public.resource_type_properties
  ADD COLUMN IF NOT EXISTS default_value JSONB;

-- Step 2: Upsert all required property rows
-- Uses ON CONFLICT (resource_type, field_name) DO UPDATE to preserve existing rows not in this list

INSERT INTO public.resource_type_properties (resource_type, field_name, required, default_value)
VALUES
  -- agent properties
  ('agent',      'content',        true,  NULL),
  ('agent',      'epochs',         false, '5'::jsonb),
  ('agent',      'worktree',       false, 'true'::jsonb),
  ('agent',      'git',            false, 'true'::jsonb),
  ('agent',      'pr',             false, 'true'::jsonb),
  ('agent',      'metric',         false, NULL),
  ('agent',      'formula',        false, NULL),
  -- skill properties
  ('skill',      'content',        true,  NULL),
  -- identity properties
  ('identity',   'handle',         true,  NULL),
  ('identity',   'platform',       false, NULL),
  -- credential properties
  ('credential', 'dopplerProject', true,  NULL),
  ('credential', 'provider',       false, NULL),
  -- proxy properties
  ('proxy',      'url',            true,  NULL),
  -- cron properties
  ('cron',       'schedule',       true,  NULL),
  ('cron',       'enabled',        false, 'true'::jsonb),
  -- user properties
  ('user',       'display_name',   true,  NULL),
  ('user',       'description',    false, '"builder"'::jsonb),
  -- server properties
  ('server',     'status',         false, '"provisioning"'::jsonb)
ON CONFLICT (resource_type, field_name)
DO UPDATE SET
  required      = EXCLUDED.required,
  default_value = EXCLUDED.default_value;
