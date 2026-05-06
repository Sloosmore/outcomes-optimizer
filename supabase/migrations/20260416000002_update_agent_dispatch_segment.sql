-- Migration: 20260416000001_update_agent_dispatch_segment
-- Updates the dispatch prompt segment to use duoidal execute (single-command v2 dispatch).
-- Replaces the old 3-step manual process (resource add + dispatch.ts + record name)
-- with a single: npx agent-core execute <goal.md> --epochs N
--
-- This migration is idempotent: running it twice produces the same state.
-- Only updates config_schema->'prompt_segments'->'dispatch' — does not touch other keys.

UPDATE resource_types
SET config_schema = jsonb_set(
  config_schema,
  '{prompt_segments,dispatch}',
  to_jsonb(
    'MANDATORY BEFORE COMPLETE: You must run oversight and dispatch the goal before writing COMPLETE. Writing the goal file is NOT the end — dispatch is.'
    || E'\n\n'
    || 'Step A — Oversight: Run 3 independent oversight reviews against your goal file using skills/oversight/references/driver-discovery.md as the rubric. Each review must score >=8.5/10 with 0 blocking findings. Fix issues and re-review until all 3 pass. If after 3 revision rounds it still fails, log the blocking findings in your driver-analysis document and move on WITHOUT dispatching.'
    || E'\n\n'
    || 'Step B — Dispatch (only if oversight passes):'
    || E'\n'
    || 'Run: npx agent-core execute docs/goals/{{goal_metric}}.md --agent {{agent_name}} --epochs 10'
    || E'\n\n'
    || 'You are NOT complete until dispatch succeeds and prints a tmux session name.'
  )
)
WHERE name = 'agent';

-- Verify the migration applied correctly
DO $$
DECLARE
  dispatch_text TEXT;
BEGIN
  SELECT config_schema->'prompt_segments'->>'dispatch'
  INTO dispatch_text
  FROM resource_types
  WHERE name = 'agent';

  IF dispatch_text IS NULL OR dispatch_text NOT LIKE '%execute%' THEN
    RAISE EXCEPTION 'Migration verification failed: dispatch segment does not contain "execute". Got: %', dispatch_text;
  END IF;

  IF dispatch_text LIKE '%resource add%' OR dispatch_text LIKE '%utils/dispatch/dispatch.ts%' THEN
    RAISE EXCEPTION 'Migration verification failed: dispatch segment still contains old manual steps. Got: %', dispatch_text;
  END IF;
END $$;
