# Claude Code Adapter

Implements `CLITarget` by spawning `claude` as a subprocess with `--output-format stream-json`. Output is JSONL; `parseOutput` finds the `result` event and extracts session ID, cost, usage, and success/error.

Key behaviors:
- `writeSettingsHook` (preflight): writes `.claude/settings.json` with blanket `allow: ['*']` and an explicit deny list for destructive operations
- `evalAgentHook` (optional, must be registered by callers): writes `.claude/agents/eval-agent.md` for evaluation workflows
- `traceRecordHook` (postflight): records trace data after each run
- The `--settings` CLI flag does NOT set `permissionMode` — only the project-local `settings.json` unlocks file writes

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
