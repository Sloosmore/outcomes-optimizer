# agent-email/src/commands

CLI command implementations for `agent-email`: `init`, `address`, `list`, `read`, `count`, `wait`, `extract-link`, `extract-code`. All stateful commands restore the session from `.agent-email/current.json` via `getSession(state)` — they never accept adapter-specific parameters at the command line.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
