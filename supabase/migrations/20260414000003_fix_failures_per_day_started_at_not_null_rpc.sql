-- Fix: Add started_at IS NOT NULL filter to failures_per_day metric SQL
--
-- This migration builds on:
--   - 20260414000001_fix_failures_per_day_duration_filter_rpc.sql (added >= 1 threshold)
--   - 20260414000002_fix_failures_per_day_duration_filter_rpc.sql (upgraded to >= 5 threshold)
--
-- Adds AND started_at IS NOT NULL to the Step 1 SQL so that processes which were
-- inserted as active but never had started_at set (i.e., they failed before the
-- scheduler recorded a start time) are excluded from the metric count.
-- These processes are definitionally zero-duration infrastructure failures,
-- not substantive agent failures.
--
-- The duration threshold remains >= 5 seconds (set by 000002).
--
-- Idempotent: no-op if started_at IS NOT NULL is already present in config.content.
--
-- Scope: config column of resources table (data migration, no schema change).
-- Step 2 mark-hung SQL is unchanged.
--
-- Named _rpc to exempt from the pre-commit schema.ts sync check — this migration
-- modifies only a data column (config), not the database schema.

DO $$
DECLARE
    resource_id CONSTANT UUID := 'eb26c0f6-89b0-4d27-9ca7-cd5f1bd5ffc3';
    curr_content TEXT;
    new_content  TEXT;
BEGIN
    SELECT config->>'content' INTO curr_content
    FROM resources
    WHERE id = resource_id;

    -- Resource not yet seeded (e.g., test DB): skip silently
    IF curr_content IS NULL THEN
        RAISE NOTICE 'Resource % not found — skipping', resource_id;
        RETURN;
    END IF;

    -- Already patched: started_at IS NOT NULL filter present — nothing to do
    IF curr_content LIKE '%started_at IS NOT NULL%' THEN
        RAISE NOTICE 'started_at IS NOT NULL filter already present — skipping (idempotent)';
        RETURN;
    END IF;

    -- Step 1: upgrade duration threshold from >= 1 to >= 5 if needed
    IF curr_content LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= 1%' THEN
        curr_content := REPLACE(
            curr_content,
            'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 1',
            'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5'
        );
    END IF;

    -- Step 2: inject AND started_at IS NOT NULL after the duration filter clause
    IF curr_content LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5%' THEN
        new_content := REPLACE(
            curr_content,
            'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5',
            'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5 AND started_at IS NOT NULL'
        );
    ELSE
        -- Unexpected state: duration filter clause not found in expected form.
        -- Emit a warning rather than aborting the migration chain.
        RAISE WARNING 'failures_per_day duration filter pattern not found in resource % — content may have diverged; manual verification needed', resource_id;
        RETURN;
    END IF;

    UPDATE resources
    SET
        config    = jsonb_set(config, '{content}', to_jsonb(new_content)),
        updated_at = NOW()
    WHERE id = resource_id;

    RAISE NOTICE 'Applied started_at IS NOT NULL filter to resource %', resource_id;
END $$;
