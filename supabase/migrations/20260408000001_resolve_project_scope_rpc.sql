-- Replaces the N+1 application-level BFS in ProjectScopeService.resolve()
-- with a single recursive CTE executed in the database.
--
-- Given project root IDs and traversable link types, returns all resource IDs
-- reachable via:
--   1. Outgoing links of the specified types (e.g. parent, runs)
--   2. Incoming member_of links (users who belong to a project)
--   3. Incoming parent links (children of a project)
--   4. One level of outgoing traversable links from discovered members

CREATE OR REPLACE FUNCTION resolve_project_scope(
  root_ids uuid[],
  traverse_link_types text[] DEFAULT ARRAY['parent', 'runs'],
  max_nodes int DEFAULT 5000
)
RETURNS TABLE (resource_id uuid) AS $$
WITH RECURSIVE
  -- Phase 1: BFS outward from roots via traversable link types.
  -- depth column guards against runaway traversal on adversarial graphs.
  outward AS (
    SELECT unnest(root_ids) AS id, 0 AS depth
    UNION
    SELECT rl.to_id, o.depth + 1
    FROM resource_links rl
    JOIN outward o ON rl.from_id = o.id
    WHERE rl.link_type = ANY(traverse_link_types)
      AND o.depth < 50
  ),
  -- Phase 2: Incoming member_of links (users who belong to project roots)
  members AS (
    SELECT rl.from_id AS id
    FROM resource_links rl
    WHERE rl.to_id = ANY(root_ids)
      AND rl.link_type = 'member_of'
  ),
  -- Phase 3: One level of outgoing traversable links from members
  member_targets AS (
    SELECT rl.to_id AS id
    FROM resource_links rl
    JOIN members m ON rl.from_id = m.id
    WHERE rl.link_type = ANY(traverse_link_types)
  ),
  -- Phase 4: Incoming containment links (children of project roots via parent or partOf)
  children AS (
    SELECT rl.from_id AS id
    FROM resource_links rl
    WHERE rl.to_id = ANY(root_ids)
      AND rl.link_type IN ('parent', 'partOf')
  ),
  -- Combine all phases
  combined AS (
    SELECT id FROM outward
    UNION
    SELECT id FROM members
    UNION
    SELECT id FROM member_targets
    UNION
    SELECT id FROM children
  )
SELECT id AS resource_id FROM combined LIMIT max_nodes;
$$ LANGUAGE sql STABLE;

-- Restrict access: only service_role may call this function.
-- anon and authenticated must not be able to enumerate the resource graph
-- by calling this RPC directly via PostgREST with arbitrary root_ids.
REVOKE ALL ON FUNCTION public.resolve_project_scope(uuid[], text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_project_scope(uuid[], text[], int) TO service_role;
