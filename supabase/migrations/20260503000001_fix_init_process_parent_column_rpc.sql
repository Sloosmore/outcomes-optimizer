-- Fix init_process() RPC: it INSERTs into parent_campaign_id, but that column
-- was renamed to parent_process_id by 20260421500000. Production has the new
-- column name on the table but the RPC body was never updated, so every
-- dispatch (calling init_process) 400s with:
--   column "parent_campaign_id" of relation "processes" does not exist
--
-- This migration redefines init_process with the correct column name. Body is
-- otherwise identical to 20260413000001 — only line that changed is the column
-- in the INSERT column list.
--
-- Idempotent: DROP+CREATE OR REPLACE; redefining is safe and fast.

DROP FUNCTION IF EXISTS public.init_process(text, text, text, text, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.init_process(
  p_name               TEXT,
  p_branch             TEXT    DEFAULT NULL,
  p_run_type           TEXT    DEFAULT 'local',
  p_worktree_path      TEXT    DEFAULT NULL,
  p_skill_resource_id  UUID    DEFAULT NULL,
  p_parent_process_id  UUID    DEFAULT NULL,
  p_project_id         UUID    DEFAULT NULL
)
RETURNS TABLE(process_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id UUID;
  v_root_id UUID;
BEGIN
  v_id := gen_random_uuid();

  IF p_parent_process_id IS NOT NULL THEN
    SELECT root_process_id INTO v_root_id
    FROM public.processes
    WHERE id = p_parent_process_id;
  END IF;
  v_root_id := COALESCE(v_root_id, v_id);

  INSERT INTO public.processes (
    id,
    name,
    branch,
    run_type,
    worktree_path,
    skill_resource_id,
    parent_process_id,
    project_id,
    status,
    root_process_id
  ) VALUES (
    v_id,
    p_name,
    p_branch,
    p_run_type,
    p_worktree_path,
    p_skill_resource_id,
    p_parent_process_id,
    p_project_id,
    'pending',
    v_root_id
  );

  INSERT INTO public.action_events (action_type, input, output, status)
  VALUES (
    'init_process',
    jsonb_build_object(
      'name',              p_name,
      'branch',            p_branch,
      'runType',           p_run_type,
      'worktreePath',      p_worktree_path,
      'skillResourceId',   p_skill_resource_id,
      'parentProcessId',   p_parent_process_id,
      'projectId',         p_project_id
    ),
    jsonb_build_object('process_id', v_id),
    'success'
  );

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.init_process(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.init_process(TEXT, TEXT, TEXT, TEXT, UUID, UUID, UUID) TO service_role;
