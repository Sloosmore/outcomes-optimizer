-- Story 7: Drop create_resource and create_link — close generic insert escape hatch.
-- 1. Refactor assign_credential, assign_proxy, add_project_member to inline direct INSERTs
-- 2. DROP FUNCTION public.create_link(UUID, UUID, TEXT)
-- 3. DROP FUNCTION public.create_resource(TEXT, TEXT, TEXT, JSONB, TEXT)
-- 4. DELETE FROM public.action_types WHERE name IN ('create_resource', 'create_link')

-- ── 1. assign_credential() RPC — inline direct INSERT ──────────────────────
DROP FUNCTION IF EXISTS public.assign_credential(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_credential(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Validate from resource exists (FOR UPDATE serializes concurrent link creations)
  PERFORM 1 FROM public.resources WHERE id = p_from_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'From resource not found: %', p_from_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate to resource exists
  PERFORM 1 FROM public.resources WHERE id = p_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'To resource not found: %', p_to_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'credential'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'credential');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_credential(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_credential(UUID, UUID) TO service_role;

-- ── 2. assign_proxy() RPC — inline direct INSERT ───────────────────────────
DROP FUNCTION IF EXISTS public.assign_proxy(uuid, uuid);
CREATE OR REPLACE FUNCTION public.assign_proxy(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Validate from resource exists (FOR UPDATE serializes concurrent link creations)
  PERFORM 1 FROM public.resources WHERE id = p_from_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'From resource not found: %', p_from_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Validate to resource exists
  PERFORM 1 FROM public.resources WHERE id = p_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'To resource not found: %', p_to_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'proxy'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'proxy');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_proxy(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_proxy(UUID, UUID) TO service_role;

-- ── 3. add_project_member() RPC — inline direct INSERT ────────────────────
DROP FUNCTION IF EXISTS public.add_project_member(uuid, uuid);
CREATE OR REPLACE FUNCTION public.add_project_member(
  p_from_id UUID,
  p_to_id   UUID
)
RETURNS TABLE(created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_from_type TEXT;
  v_to_type   TEXT;
BEGIN
  -- Validate from resource exists and is type=user
  SELECT type INTO v_from_type FROM public.resources WHERE id = p_from_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User resource not found: %', p_from_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_from_type != 'user' THEN
    RAISE EXCEPTION 'add_project_member requires from resource to be type=user, got %', v_from_type
      USING ERRCODE = '22023';
  END IF;

  -- Validate to resource exists and is type=project
  SELECT type INTO v_to_type FROM public.resources WHERE id = p_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project resource not found: %', p_to_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_to_type != 'project' THEN
    RAISE EXCEPTION 'add_project_member requires to resource to be type=project, got %', v_to_type
      USING ERRCODE = '22023';
  END IF;

  -- Idempotency: if this exact link already exists, return created=false
  IF EXISTS (
    SELECT 1 FROM public.resource_links
    WHERE from_id = p_from_id AND to_id = p_to_id AND link_type = 'member_of'
  ) THEN
    RETURN QUERY SELECT FALSE;
    RETURN;
  END IF;

  INSERT INTO public.resource_links (from_id, to_id, link_type)
  VALUES (p_from_id, p_to_id, 'member_of');

  RETURN QUERY SELECT TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.add_project_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_project_member(UUID, UUID) TO service_role;

-- ── 4. Drop create_link and create_resource ────────────────────────────────
DROP FUNCTION IF EXISTS public.create_link(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.create_resource(TEXT, TEXT, TEXT, JSONB, TEXT);

-- ── 5. Remove action_types rows for dropped functions ─────────────────────
-- Must delete referencing action_events rows first (FK: action_events_action_type_fkey)
DELETE FROM public.action_events WHERE action_type IN ('create_resource', 'create_link');
DELETE FROM public.action_types WHERE name IN ('create_resource', 'create_link');
