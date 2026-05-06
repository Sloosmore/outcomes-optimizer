-- Fix provision_sandbox:
-- 1. Remove the privateKey-accepting RPC variant — private keys stay local, never in DB.
--    The CLI unit test (sandbox.test.ts) explicitly asserts privateKey is NOT passed to
--    executeAction. Only the original 5-param variant (without p_private_key) is kept.
-- 2. Fix input_schema to not require or accept privateKey.
-- Both fixes are idempotent (DROP IF EXISTS, WHERE = check).

-- Drop the privateKey variant if it was mistakenly added by an earlier migration
DROP FUNCTION IF EXISTS public.provision_sandbox(
  p_user_resource_id uuid,
  p_server_name text,
  p_ssh_key_name text,
  p_public_key text,
  p_private_key text,
  p_hetzner_server_id text
);

-- Fix input_schema: no privateKey
UPDATE public.action_types
SET input_schema = '{
  "type": "object",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "required": ["userResourceId", "serverName", "sshKeyName", "publicKey"],
  "properties": {
    "publicKey":       { "type": "string" },
    "serverName":      { "type": "string" },
    "sshKeyName":      { "type": "string" },
    "userResourceId":  { "type": "string", "description": "UUID of the user resource" }
  },
  "additionalProperties": false
}'::jsonb
WHERE name = 'provision_sandbox';
