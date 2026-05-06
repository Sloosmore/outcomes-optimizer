-- Migration: 20260416000001_backfill_waiting_segment_project_id
-- Backfills project_id on existing waiting process segments that have project_id = NULL.
--
-- Before Story 2, the sleep() method in packages/database/src/services/processes.ts
-- did not propagate project_id from the parent process to the new waiting segment.
-- Story 2 fixed this for new sleeps. This migration backfills existing rows so
-- project-scoped wake queries can find them correctly.
--
-- ROLLBACK: project_id on waiting segments can be set back to NULL if needed, but
-- this backfill is safe and idempotent — re-running will update zero rows.

UPDATE processes p
SET project_id = root.project_id
FROM processes root
WHERE p.root_process_id = root.id
  AND p.project_id IS NULL
  AND p.status = 'waiting'
  AND root.project_id IS NOT NULL;
