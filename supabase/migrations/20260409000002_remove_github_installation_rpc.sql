-- Removes GitHub App connection for a user resource.
-- Deletes the resource_links row (github_app type) and the credential resource.
-- Does NOT call GitHub API — installation stays on GitHub's side.

DROP FUNCTION IF EXISTS public.remove_github_installation(uuid);
CREATE OR REPLACE FUNCTION public.remove_github_installation(
  p_user_resource_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'pg_catalog'
AS $function$
DECLARE
  v_credential_id UUID;
BEGIN
  -- Ownership check
  IF NOT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_user_resource_id
      AND type = 'user'
      AND auth_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Access denied: you do not own this user resource'
      USING ERRCODE = '42501';
  END IF;

  -- Find and delete the github_app link, get credential ID
  SELECT to_id INTO v_credential_id
  FROM public.resource_links
  WHERE from_id = p_user_resource_id
    AND link_type = 'github_app'
  LIMIT 1;

  IF v_credential_id IS NOT NULL THEN
    -- Delete both directions of links involving the credential
    DELETE FROM public.resource_links
    WHERE (from_id = p_user_resource_id AND link_type = 'github_app')
       OR (from_id = v_credential_id AND to_id = p_user_resource_id AND link_type = 'parent');

    -- Delete the credential resource
    DELETE FROM public.resources
    WHERE id = v_credential_id
      AND type = 'credential';
  END IF;
END;
$function$;

-- Register in action_types
INSERT INTO public.action_types (name, rpc_function, description, input_schema, output_schema, param_mapping, result_mapping, schema_version)
VALUES (
  'remove_github_installation',
  'remove_github_installation',
  'Disconnects GitHub App by removing the resource_links row and credential resource. Does not revoke installation on GitHub.',
  '{
    "type": "object",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "required": ["userResourceId"],
    "properties": {
      "userResourceId": {"type": "string", "format": "uuid", "description": "UUID of the user resource"}
    },
    "additionalProperties": false
  }'::jsonb,
  '{"type": "object", "properties": {}}'::jsonb,
  '{"userResourceId": "p_user_resource_id"}'::jsonb,
  '{}'::jsonb,
  1
)
ON CONFLICT (name) DO NOTHING;
