-- Rename processes.parent_campaign_id → parent_process_id.
--
-- Production was renamed via the now-deleted drizzle/0053 migration (PR #461).
-- The supabase/migrations/ chain (used by the per-worktree compose database
-- container's docker-entrypoint-initdb.d/) never received the rename, so a
-- fresh compose init exits 3 on 20260422000003_fix_restart_project_id_backfill_rpc.sql,
-- which assumes the new column name. This migration backfills the rename for
-- the supabase-init path.
--
-- Idempotent: only renames if the old column still exists. Production rows where
-- the rename already happened are no-ops.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'processes'
      AND column_name = 'parent_campaign_id'
  ) THEN
    ALTER TABLE processes RENAME COLUMN parent_campaign_id TO parent_process_id;
  END IF;
END $$;

-- Drop legacy FK constraints from baseline / pre-rename eras if they survived.
ALTER TABLE processes DROP CONSTRAINT IF EXISTS processes_parent_campaign_id_processes_id_fk;
ALTER TABLE processes DROP CONSTRAINT IF EXISTS campaigns_parent_campaign_id_campaigns_id_fk;
ALTER TABLE processes DROP CONSTRAINT IF EXISTS processes_parent_campaign_id_fkey;

-- Re-add FK under the new name if not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'processes'
      AND constraint_name = 'processes_parent_process_id_processes_id_fk'
  ) THEN
    ALTER TABLE processes
      ADD CONSTRAINT processes_parent_process_id_processes_id_fk
      FOREIGN KEY (parent_process_id) REFERENCES processes(id);
  END IF;
END $$;
