-- Migration: 20260405000001_agent_prompt_segments_v2
-- Adds shared prompt segments to the agent resource type.
-- These segments are appended to the agent's prompt when the corresponding
-- flag is set on the agent's config (e.g., driver_discovery: true).
--
-- This migration ONLY touches resource_types — agent config.content and
-- flags are managed operationally, not through migrations.
--
-- Note: {{goal_metric}} placeholders are expanded at runtime by the agent
-- dispatch system when the prompt is assembled.
--
-- PREREQUISITE: The 'agent' resource type must exist in resource_types before
-- this migration runs. It is provisioned operationally, not via the baseline
-- seed. On a fresh DB without the agent row, this migration will fail loudly
-- at the verification block — this is intentional.
--
-- ROLLBACK: To revert this migration:
--   UPDATE resource_types
--   SET config_schema = config_schema
--     #- '{prompt_segments,driver_discovery}'
--     #- '{prompt_segments,dispatch}'
--     #- '{prompt_segments,goal}'
--   WHERE name = 'agent';
-- Then re-apply 20260403000001_goal_prompt_segment_oversight_gate.sql to restore
-- the previous goal segment.

-- Set all three prompt segments in a single UPDATE to prevent partial failure.
-- Uses COALESCE for NULL safety and ensures the prompt_segments intermediate key
-- exists before setting nested keys.
UPDATE resource_types
SET config_schema = jsonb_set(
  jsonb_set(
    jsonb_set(
      -- Ensure prompt_segments key exists before nesting into it
      jsonb_set(
        COALESCE(config_schema, '{}'::jsonb),
        '{prompt_segments}',
        COALESCE(config_schema -> 'prompt_segments', '{}'::jsonb)
      ),
      '{prompt_segments,driver_discovery}',
      to_jsonb(
        'After recording your metric, run driver-discovery analysis to identify what is causing the metric to be where it is. '
        || 'Produce a structured analysis at docs/driver-analysis/{{goal_metric}}.md on your PR branch with these sections:'
        || E'\n\n'
        || '1. **Hypothesis table** — rank candidate drivers by Impact * Evidence * Tractability. Each row: driver name, mechanism, artifact citation, scores, recommended experiment.'
        || E'\n'
        || '2. **Driver Landscape** — describe each driver with artifact citations (file:line, DB field config form, or config.content step form). Every claim must cite a real artifact.'
        || E'\n'
        || '3. **Why #1** — select the top driver. Explicitly reject each non-selected candidate BY NAME with evidence for why it ranks lower.'
        || E'\n'
        || '4. **Inception Level** — causal chain with >=3 WHY levels, ending at ROOT with CONFIDENCE and CONFIDENCE REASON.'
        || E'\n'
        || '5. **Categories Checked** — all 7 categories: computation source errors, input data quality, exclusion/filtering logic, dispatch/infrastructure failures, prompt/goal specification, external dependencies, reference constants/calibration values.'
        || E'\n\n'
        || 'Citation rules: cite every claim via source code path:line, DB field, or config.content step. SQL fragments and fabricated citations are auto-rejected. '
        || 'Always git show to verify commit messages and file contents before citing them.'
      )
    ),
    '{prompt_segments,dispatch}',
    to_jsonb(
      'MANDATORY BEFORE COMPLETE: You must run oversight and dispatch the goal before writing COMPLETE. '
      || 'Writing the goal file is NOT the end — dispatch is.'
      || E'\n\n'
      || 'Step A — Oversight: Run 3 independent oversight reviews against your goal file using '
      || 'skills/oversight/references/driver-discovery.md as the rubric. Each review must score >=8.5/10 '
      || 'with 0 blocking findings. Fix issues and re-review until all 3 pass. '
      || 'If after 3 revision rounds it still fails, log the blocking findings in your driver-analysis document '
      || 'and move on WITHOUT dispatching.'
      || E'\n\n'
      || 'Step B — Dispatch (only if oversight passes):'
      || E'\n'
      || '1. Upload the goal as a skill resource: npx agent-core resource add --type skill '
      || '--name "skill/goal-$(echo {{goal_metric}} | tr _ -)" '
      || '--config "$(jq -Rs ''{content: .}'' docs/goals/{{goal_metric}}.md)"'
      || E'\n'
      || '2. Dispatch: npx tsx utils/dispatch/dispatch.ts --skill-resource-id "$SKILL_RESOURCE_ID" --epochs 10 --unlinked'
      || E'\n'
      || '3. Record the dispatched process name in workspace/state.json'
      || E'\n\n'
      || 'You are NOT complete until dispatch succeeds and returns a process name.'
    )
  ),
  '{prompt_segments,goal}',
  to_jsonb(
    'After completing your driver-discovery analysis, write a dispatchable goal file at '
    || 'docs/goals/{{goal_metric}}.md on your PR branch targeting the #1 driver from your analysis. '
    || 'The goal must:'
    || E'\n\n'
    || '- Address only the #1 driver (not a wishlist)'
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
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM resource_types
    WHERE name = 'agent'
      AND config_schema ? 'prompt_segments'
      AND config_schema -> 'prompt_segments' ? 'driver_discovery'
      AND config_schema -> 'prompt_segments' ? 'dispatch'
      AND config_schema -> 'prompt_segments' ? 'goal'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: agent resource type is missing expected prompt_segments keys (driver_discovery, dispatch, goal). Ensure the agent row exists in resource_types before running this migration.';
  END IF;
END $$;
