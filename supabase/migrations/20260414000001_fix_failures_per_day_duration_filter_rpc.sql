-- Fix: Exclude zero-duration process failures from failures_per_day metric
--
-- Zero-duration failures (EXTRACT(EPOCH FROM (updated_at - created_at)) < 1)
-- occur when validateSkillConfig returns false or dispatchRun throws immediately
-- in packages/scheduler/src/poller.ts. These inflate the metric because they
-- represent cron infrastructure failures, not substantive agent failures.
--
-- This migration adds a duration filter to Step 1 of the prod-failures skill
-- config.content so that only processes that ran for >= 1 second are counted.
--
-- NOTE: The >= 1 threshold set here is an intermediate state intentionally
-- superseded by 20260414000002_fix_failures_per_day_duration_filter_rpc.sql,
-- which upgrades the threshold to >= 5 seconds. Both migrations must be applied
-- together; on a fresh DB, 000002 overrides the value written here.
--
-- Scope: config column of resources table (data migration, no schema change).
-- Step 2 mark-hung SQL is unchanged.
--
-- Idempotent: skips if any duration filter is already present (i.e., 000001 or
-- 000002 has already been applied), so replaying this migration cannot downgrade
-- a >= 5 threshold back to >= 1.
--
-- NOTE: Do NOT edit the threshold value here. Both 000001 and 000002 were applied
-- together and 000002 is the authoritative final state (>= 5). Any future threshold
-- change should be a new forward migration, not an edit to this file.
--
-- DESIGN NOTE: This migration rewrites the entire config.content blob. 000002 uses
-- surgical REPLACE() instead, which is the safer pattern. This inconsistency is
-- intentional — 000001 was already applied to production when 000002 was added;
-- changing 000001 to use REPLACE() would require coordinating idempotency guards
-- across DB states. Future migrations on this resource should use REPLACE().

UPDATE resources
SET
  config = jsonb_set(
    config,
    '{content}',
    to_jsonb(
      'You are the prod-failures metric agent.' || chr(10) || chr(10) ||
      'Step 1 — Record metric:' || chr(10) ||
      'Count failed processes in the last 4 hours:' || chr(10) ||
      'SELECT COUNT(*)::int FROM processes WHERE status = ''failed'' AND created_at >= NOW() - INTERVAL ''4 hours'' AND EXTRACT(EPOCH FROM (updated_at - created_at)) >= 1' || chr(10) ||
      'Record via: npx agent-core metrics record --skill-id eb26c0f6-89b0-4d27-9ca7-cd5f1bd5ffc3 --key failures_per_day --value ' || chr(10) || chr(10) ||
      'Step 2 — Mark hung processes:' || chr(10) ||
      'UPDATE processes SET status = ''failed'' WHERE status = ''active'' AND started_at < NOW() - INTERVAL ''48 hours'' AND name NOT LIKE ''cron-%''' || chr(10) ||
      'Log how many were marked.'
    )
  ),
  updated_at = NOW()
WHERE id = 'eb26c0f6-89b0-4d27-9ca7-cd5f1bd5ffc3'
  -- Broad guard: matches ANY duration threshold (>= 1, >= 5, etc.) to prevent
  -- downgrading a higher threshold back to >= 1. This intentionally matches more
  -- than just ">= 1" — if you add additional duration comparisons to config.content
  -- (e.g., for a different column), revisit this guard to ensure it stays correct.
  AND config->>'content' NOT LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= %';
