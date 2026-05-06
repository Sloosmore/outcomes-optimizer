# agent-email/src/state

Manages persistent inbox state in `.agent-email/current.json`. Handles path resolution (env var override → `config.yaml` → default), path traversal validation, file permissions (0o600 / 0o700), and the `seenIds` set used by the `wait` command to avoid re-delivering already-seen emails.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
