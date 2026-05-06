# Utils Config

YAML configuration loading with Zod validation. `loadConfig(path?)` reads `config.yaml` (or a custom path), parses it with `yaml`, and validates against `configSchema`. Throws a descriptive error listing all validation failures if the schema is not satisfied.

Key schema fields: `campaign.name`, `database.adapter` (none/local/cloud), `cli.adapter` (claude-code/claude-agent-sdk/codex/mock), `cli.workingDir`, `skills`, `identity`, `eval`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
