-- Migration: 20260415000001_goal_segment_liveness_check
-- Adds a liveness check to the goal prompt segment on the agent resource type.
-- Before writing a goal targeting driver #1, the agent must verify the gap still
-- exists in the live system. If resolved, move down the stack. If all resolved,
-- write COMPLETE without dispatching.
--
-- Motivation: Three consecutive daily cycles (Apr 13-14) all targeted the same
-- driver because none checked whether a prior cycle had already fixed it. The
-- child process opened a no-op PR with zero code changes.
--
-- ROLLBACK: Re-apply 20260407000010_agent_prompt_segments_v2.sql to restore the
-- previous goal segment.

UPDATE resource_types
SET config_schema = jsonb_set(
  COALESCE(config_schema, '{}'::jsonb),
  '{prompt_segments,goal}',
  to_jsonb(
    'After completing your driver-discovery analysis, verify the #1 driver''s gap still exists '
    || 'before writing a goal. Check the artifact cited in your analysis against the live system — '
    || 'query the DB, read the file, or inspect the config. If the current state already reflects the fix, '
    || 'the driver is resolved — move to #2. Repeat down the stack. If all drivers are resolved, '
    || 'write COMPLETE without dispatching — a clean bill of health is a valid outcome.'
    || E'\n\n'
    || 'Once you have confirmed a driver whose gap is still live, write a dispatchable goal file at '
    || 'docs/goals/{{goal_metric}}.md on your PR branch targeting that driver. '
    || 'The goal must:'
    || E'\n\n'
    || '- Address only one driver (not a wishlist)'
    || E'\n'
    || '- Follow the 6-section format: Architecture, Prerequisites, Success Criteria, Metrics, Constraints, Post-Loop Action'
    || E'\n'
    || '- Contain >=3 mechanically verifiable success criteria (bash/psql/grep/gh commands that exit non-zero on failure)'
    || E'\n'
    || '- Include >=1 non-regression criterion and >=1 negative test'
    || E'\n'
    || '- Contain zero implementation steps — success criteria and verification methods only'
    || E'\n'
    || '- Include a mermaid architecture diagram'
    || E'\n'
    || '- Every criterion must produce observable evidence in the real system'
    || E'\n\n'
    || 'Before writing criteria, read the ## Verification section from the CLAUDE.md of every package/service '
    || 'in the goals blast radius. Use those proof patterns as your floor, not your ceiling.'
  )
)
WHERE name = 'agent';

-- Verify the migration applied correctly
DO $$
DECLARE
  segment_text text;
BEGIN
  SELECT config_schema -> 'prompt_segments' ->> 'goal'
  INTO segment_text
  FROM resource_types
  WHERE name = 'agent';

  IF segment_text IS NULL THEN
    RAISE EXCEPTION 'Migration verification failed: goal prompt segment is NULL after update';
  END IF;

  IF position('verify' IN segment_text) = 0 THEN
    RAISE EXCEPTION 'Migration verification failed: goal segment does not contain liveness check text';
  END IF;

  IF position('clean bill of health' IN segment_text) = 0 THEN
    RAISE EXCEPTION 'Migration verification failed: goal segment missing "clean bill of health" escape hatch';
  END IF;
END $$;
