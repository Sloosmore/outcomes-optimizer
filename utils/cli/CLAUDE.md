# Utils CLI

The CLI infrastructure layer. `getCLITarget()` reads `config.yaml`, selects the configured adapter (claude-code, claude-agent-sdk, codex, or mock), and returns a `CLITarget` object that abstracts all adapter-specific behavior. Callers (primarily `utils/run`) interact only with this interface.

Preflight hooks run before each CLI execution (e.g., writing `.claude/settings.json`). Postflight hooks run after (e.g., recording traces). All hooks are registered on the target and run sequentially.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
