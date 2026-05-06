# Utils Prompts

Loads the optimization framework prompt and policy prompts from files co-located in this directory.

`loadOptimizationPrompt()` — reads `optimization.md` relative to this module's `__dirname`. Throws with a clear path if the file is missing.

`loadPolicyPrompt(type)` — reads `policies.json` and returns the `prompt` field for the given `PolicyType` (`value_based`, `policy_gradient`, `actor_critic`). Throws if the type is unknown.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
