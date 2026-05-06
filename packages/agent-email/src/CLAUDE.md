# agent-email/src

Root source for the `agent-email` CLI. `index.ts` wires all subcommands (`init`, `address`, `list`, `read`, `count`, `wait`, `extract-link`, `extract-code`) into the Commander program and registers the adapter registry at startup.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
