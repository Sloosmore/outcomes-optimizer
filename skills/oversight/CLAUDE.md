# skills/oversight

Version-controlled skill that provides autonomous adversarial review of agent outputs. Runs blind validation against plans or results using parallel subagents. Composable — any agent or workflow can invoke it for independent validation.

Modes: `generate`, `adversarial`, `validate`, `diagnose`, `driver-discovery`.

Subdirectories:
- `references/` — Prompts for each subagent role (generator, prd-validator, comparator, adversarial, output-validator, diagnose, driver-discovery)

See `SKILL.md` for the complete skill specification.

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
