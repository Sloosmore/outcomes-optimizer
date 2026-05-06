# Codex Adapter

Implements `CLITarget` by spawning `codex exec` with `--json` output (JSONL). Parses `thread.started`, `turn.completed`, and `turn.failed` events. The postflight `save-codex-traces` hook copies today's `.jsonl` session files from `~/.codex/sessions/YYYY/MM/DD/` into `workspace/.codex-logs/`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
