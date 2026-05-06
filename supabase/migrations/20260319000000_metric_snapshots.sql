BEGIN;

-- Create metric_snapshots table
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id      uuid        NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  metric_key    text        NOT NULL,
  value         numeric     NOT NULL,
  measured_at   timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb       DEFAULT '{}',
  CONSTRAINT uq_metric_snapshots UNIQUE (skill_id, metric_key, measured_at)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_skill_key_ts
  ON metric_snapshots (skill_id, metric_key, measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_measured_at
  ON metric_snapshots (measured_at);

-- Row Level Security: service_role only
ALTER TABLE "public"."metric_snapshots" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_full_access" ON "public"."metric_snapshots";
CREATE POLICY "service_role_full_access"
  ON "public"."metric_snapshots"
  AS PERMISSIVE FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMIT;
