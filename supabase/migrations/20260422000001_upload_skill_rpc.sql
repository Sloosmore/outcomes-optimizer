-- Create upload_skill RPC: uploads a skill resource and returns its resource ID.
-- The actor_id identifies the user uploading the skill (used for naming).
DROP FUNCTION IF EXISTS public.upload_skill(uuid, text);
CREATE OR REPLACE FUNCTION public.upload_skill(
  p_actor_id UUID,
  p_content  TEXT
)
RETURNS TABLE(resource_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_id   UUID;
  v_name TEXT;
BEGIN
  -- Generate a unique name for the skill resource
  v_name := 'skill:upload:' || p_actor_id::text || ':' || extract(epoch FROM now())::bigint::text;

  INSERT INTO public.resources (id, name, type, status, config)
  VALUES (
    gen_random_uuid(),
    v_name,
    'skill',
    'active',
    jsonb_build_object('content', p_content)
  )
  RETURNING id INTO v_id;

  INSERT INTO public.action_events (action_type, input, output, status)
  VALUES (
    'upload_skill',
    jsonb_build_object('actorId', p_actor_id, 'content', p_content),
    jsonb_build_object('resource_id', v_id),
    'success'
  );

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upload_skill(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upload_skill(UUID, TEXT) TO service_role;
