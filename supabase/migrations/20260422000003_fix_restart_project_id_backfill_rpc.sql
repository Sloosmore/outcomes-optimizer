-- Fix: duoidal process restart must copy project_id to child
--
-- The restart() function in packages/database/src/services/processes.ts
-- (TypeScript, not a SQL RPC) was updated in commit e70c16440 to include
-- project_id in the INSERT. This migration backfills the historical broken
-- rows that were created before the fix.
--
-- Backfill: child processes that have parent_process_id set but project_id IS NULL
-- while their parent has a non-null project_id. This makes them visible on
-- project dashboards retroactively.

UPDATE processes child
SET project_id = parent.project_id
FROM processes parent
WHERE child.parent_process_id = parent.id
  AND child.project_id IS NULL
  AND parent.project_id IS NOT NULL;
