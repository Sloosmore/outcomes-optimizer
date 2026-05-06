-- Add deprovision_sandbox to action_types registry
INSERT INTO public.action_types (name, rpc_function, input_schema, output_schema, param_mapping, result_mapping, description)
VALUES (
  'deprovision_sandbox',
  'deprovision_sandbox',
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["serverResourceId"],
    "properties": {
      "serverResourceId": { "type": "string", "description": "UUID of the server resource to deprovision" }
    },
    "additionalProperties": false
  }'::jsonb,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "deleted": { "type": "boolean" },
      "serverName": { "type": "string" }
    }
  }'::jsonb,
  '{"serverResourceId": "p_server_resource_id"}'::jsonb,
  '{"deleted": "deleted", "server_name": "serverName"}'::jsonb,
  'Deprovisions a sandbox server resource and cleans up all linked resources'
)
ON CONFLICT (name) DO UPDATE SET
  rpc_function  = EXCLUDED.rpc_function,
  input_schema  = EXCLUDED.input_schema,
  output_schema = EXCLUDED.output_schema,
  param_mapping = EXCLUDED.param_mapping,
  result_mapping = EXCLUDED.result_mapping,
  description   = EXCLUDED.description;
