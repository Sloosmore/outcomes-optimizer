-- process_events_chain: consolidates 3-query process event resolution into a single RPC
-- Replaces: (1) SELECT root_process_id, (2) SELECT chain by root, (3) SELECT/COUNT agent_events
-- Returns events + total count (total = 0 when cursor is set, matching BFF behaviour)
CREATE OR REPLACE FUNCTION process_events_chain(
  p_process_id uuid,
  p_limit      int         DEFAULT 50,
  p_before     timestamptz DEFAULT NULL,
  p_after      timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  process_id uuid,
  resource_id uuid,
  source     text,
  payload    jsonb,
  ts         timestamptz,
  total      bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_catalog'
AS $$
DECLARE
  v_root_id uuid;
BEGIN
  -- Resolve root_process_id; fall back to p_process_id if not found
  SELECT COALESCE(p.root_process_id, p_process_id)
  INTO v_root_id
  FROM processes p
  WHERE p.id = p_process_id;

  IF v_root_id IS NULL THEN
    v_root_id := p_process_id;
  END IF;

  RETURN QUERY
  WITH chain_ids AS (
    -- All segments sharing this root, plus the root/process itself
    SELECT p.id
    FROM   processes p
    WHERE  p.root_process_id = v_root_id
    UNION
    SELECT v_root_id
  ),
  filtered_events AS (
    SELECT ae.id, ae.process_id, ae.resource_id, ae.source, ae.payload, ae.ts
    FROM   agent_events ae
    WHERE  ae.process_id IN (SELECT ci.id FROM chain_ids ci)
      AND  (p_before IS NULL OR ae.ts < p_before)
      AND  (p_after  IS NULL OR ae.ts > p_after)
  )
  SELECT
    fe.id,
    fe.process_id,
    fe.resource_id,
    fe.source,
    fe.payload,
    fe.ts,
    -- Only count on uncursored (initial) load — matches current BFF behaviour
    CASE
      WHEN p_before IS NULL AND p_after IS NULL THEN COUNT(*) OVER ()
      ELSE 0::bigint
    END AS total
  FROM filtered_events fe
  ORDER BY
    CASE WHEN p_after IS NOT NULL THEN fe.ts END ASC  NULLS LAST,
    CASE WHEN p_after IS     NULL THEN fe.ts END DESC NULLS LAST
  LIMIT p_limit;
END;
$$;

-- Grant to authenticated role (used by Supabase client in BFF)
GRANT EXECUTE ON FUNCTION process_events_chain(uuid, int, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION process_events_chain(uuid, int, timestamptz, timestamptz) TO service_role;
