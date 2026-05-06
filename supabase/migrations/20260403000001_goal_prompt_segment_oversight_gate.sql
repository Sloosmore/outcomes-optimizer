-- Migration: 20260403000001_goal_prompt_segment_oversight_gate
-- Amends the goal prompt segment to require self-oversight before committing.
-- Cron agents with goal: true must run oversight on their generated goal and
-- iterate until it passes before committing to the PR branch.

UPDATE resource_types
SET config_schema = jsonb_set(
  config_schema,
  '{prompt_segments,goal}',
  to_jsonb(
    'After completing your driver-discovery analysis, write a complete, dispatchable goal file targeting the #1 driver. '
    || 'The goal must: address only the #1 driver from your analysis (not a wishlist); '
    || 'follow standard goal format with all 6 sections (Architecture, Prerequisites, Success Criteria, Metrics, Constraints, Post-Loop Action); '
    || 'contain at least 3 mechanically verifiable success criteria each with a bash/psql/grep/gh command that exits with a code; '
    || 'include at least one non-regression criterion and one negative test; '
    || 'contain zero implementation steps (success criteria and verification methods only); '
    || 'include a mermaid architecture diagram. '
    || 'Every criterion must produce observable evidence in the real system — a live database query, an API call, a CLI command against production state, or a file in the repo that drives actual behavior. '
    || 'Mock assertions, test stubs, in-memory checks, or source-pattern greps that can be satisfied by inserting a comment are not valid verification methods. '
    || E'\n\n'
    || 'Before committing the goal file, validate it: run 3 independent oversight reviews against the driver-discovery punitive rubric (skills/oversight/references/driver-discovery.md). '
    || 'Each review must score >=8.5/10 with 0 blocking findings. '
    || 'If any review fails, fix the identified issues and re-run oversight until all 3 pass. '
    || 'If after 3 revision rounds the goal still does not pass, do not commit it — log the blocking findings in your driver-analysis document and move on. '
    || 'Only commit the goal file to `docs/goals/{{goal_metric}}.md` on your PR branch after all 3 oversight reviews pass.'
  )
)
WHERE name = 'agent';
