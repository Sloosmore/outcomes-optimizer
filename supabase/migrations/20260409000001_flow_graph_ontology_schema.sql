-- Migration: flow_graph_ontology_schema
-- Adds package/service/repository resource types, traverses link type,
-- link_type_rules for dependsOn/hostedOn/traverses, and temporal soft-delete
-- columns (valid_from/valid_to) on resource_links.

-- ============================================================
-- 1. New resource types
-- ============================================================
INSERT INTO resource_types (name, description)
VALUES
  ('package',    'NPM package or library within the workspace'),
  ('service',    'Deployed HTTP service or process'),
  ('repository', 'Git repository hosting packages and services')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2. New link type: traverses
-- ============================================================
INSERT INTO link_types (name, description, cardinality)
VALUES
  ('traverses', 'User flow traverses this package or service', 'many-to-many')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 3. New link_type_rules
-- ============================================================

-- dependsOn rules
INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES
  ('dependsOn', 'package', 'package', 0, NULL),
  ('dependsOn', 'service', 'package', 0, NULL),
  ('dependsOn', 'service', 'service', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- hostedOn rules
INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES
  ('hostedOn', 'package',    'repository', 0, NULL),
  ('hostedOn', 'service',    'repository', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- traverses rules
INSERT INTO link_type_rules (link_type, from_type, to_type, min_count, max_count)
VALUES
  ('traverses', 'skill', 'package', 0, NULL),
  ('traverses', 'skill', 'service', 0, NULL)
ON CONFLICT ON CONSTRAINT uq_link_type_rules DO NOTHING;

-- ============================================================
-- 4. Temporal soft-delete columns on resource_links
-- Note: valid_from/valid_to add temporal tracking but NOT full bitemporality
-- because the PK is still (from_id, to_id, link_type). Only one row can
-- exist per edge triple; valid_to=NULL means active, non-NULL means closed.
-- This is soft-delete with timestamps, not SCD-2 history.
-- ============================================================

-- Add valid_from as nullable first so the backfill below actually runs.
-- (Adding with DEFAULT NOW() would freeze every existing row to migration time,
-- making the backfill a no-op. Nullable add + explicit UPDATE + NOT NULL is safer.)
ALTER TABLE resource_links
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;

-- Backfill existing rows from created_at
UPDATE resource_links
SET valid_from = created_at
WHERE valid_from IS NULL;

-- Enforce NOT NULL, then set default for future inserts
ALTER TABLE resource_links
  ALTER COLUMN valid_from SET NOT NULL;

ALTER TABLE resource_links
  ALTER COLUMN valid_from SET DEFAULT NOW();

-- Add valid_to (nullable, NULL means "still valid")
ALTER TABLE resource_links
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ DEFAULT NULL;

-- Partial index for active-link queries (WHERE valid_to IS NULL)
-- traverse command and other queries filter on link_type + valid_to IS NULL;
-- this index makes those queries O(active links) not O(all links).
CREATE INDEX IF NOT EXISTS idx_resource_links_active
  ON resource_links (link_type)
  WHERE valid_to IS NULL;
