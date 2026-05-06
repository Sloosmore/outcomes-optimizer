-- Fix: Upgrade failures_per_day duration filter to >= 5 seconds
--
-- Goal success criterion specifies that sub-5-second process failures
-- (EXTRACT(EPOCH FROM (updated_at - created_at)) < 5) must be excluded
-- from the failures_per_day count. The preceding migration
-- (20260414000001_fix_failures_per_day_duration_filter_rpc.sql) introduced
-- a >= 1 threshold; this migration upgrades it to >= 5 seconds.
--
-- On a DB where >= 1 was applied, upgrades to >= 5.
-- Idempotent: no-op if filter is already >= 5.
--
-- Using timestamp 000002 ensures this runs AFTER 000001 regardless of locale
-- (lexicographic digit sort is locale-independent; the previous _rpc approach
-- relied on '.' < '_' in ASCII which reverses under en_US.UTF-8 collation).
--
-- Scope: config column of resources table (data migration, no schema change).

DO $$
DECLARE
    resource_id CONSTANT UUID := 'eb26c0f6-89b0-4d27-9ca7-cd5f1bd5ffc3';
    n            INT;
    curr_content TEXT;
BEGIN
    SELECT config->>'content' INTO curr_content
    FROM resources
    WHERE id = resource_id;

    -- Resource not yet seeded (e.g., test DB): skip silently
    IF curr_content IS NULL THEN
        RAISE NOTICE 'Resource % not found — skipping', resource_id;
        RETURN;
    END IF;

    -- Already at >= 5: nothing to do (anchor on trailing newline to avoid matching >= 50, >= 500, etc.)
    IF curr_content LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5' || chr(10) || '%'
    OR curr_content LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5' THEN
        RAISE NOTICE 'Duration filter already at >= 5 — skipping (idempotent)';
        RETURN;
    END IF;

    -- Upgrade from >= 1 (set by prior migration) to >= 5
    -- Use precise boundary pattern ('= 1' || newline) to avoid matching >= 10, >= 15, etc.
    IF curr_content LIKE '%EXTRACT(EPOCH FROM (updated_at - created_at)) >= 1' || chr(10) || '%' THEN
        UPDATE resources
        SET
            config = jsonb_set(
                config,
                '{content}',
                to_jsonb(REPLACE(
                    curr_content,
                    'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 1' || chr(10),
                    'EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5' || chr(10)
                ))
            ),
            updated_at = NOW()
        WHERE id = resource_id;
        RAISE NOTICE 'Upgraded duration filter from >= 1 to >= 5';
        RETURN;
    END IF;

    -- Fresh DB path: no duration filter present — add >= 5 surgically.
    -- NOTE: In normal deployment, 000001_rpc runs first and installs >= 1, so
    -- control reaches here only in the extremely rare case where 000001 was
    -- skipped (e.g., manual migration replay that omitted it). This block is
    -- a defensive fallback; treat it as belt-and-suspenders, not the happy path.
    UPDATE resources
    SET
        config = jsonb_set(
            config,
            '{content}',
            to_jsonb(REPLACE(
                curr_content,
                'AND created_at >= NOW() - INTERVAL ''4 hours''',
                'AND created_at >= NOW() - INTERVAL ''4 hours'' AND EXTRACT(EPOCH FROM (updated_at - created_at)) >= 5'
            ))
        ),
        updated_at = NOW()
    WHERE id = resource_id;

    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
        -- config.content has drifted from the expected seed pattern — emit a warning
        -- rather than aborting the migration chain, to avoid blocking future migrations.
        RAISE WARNING 'failures_per_day filter pattern not found in resource % — content may have diverged; manual verification needed', resource_id;
    END IF;
END $$;
