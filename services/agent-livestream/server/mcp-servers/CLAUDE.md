# agent-livestream/server/mcp-servers

In-process MCP server tools made available to research agents running in the agent-livestream context. Currently contains:

- `mermaid.ts` — Registers `mermaid_preview` and `mermaid_save` tools. Writes diagram files to the `claude-mermaid` persistent server's data directory (`~/.config/claude-mermaid/live/{id}/`), causing diagrams to appear in the running `claude-mermaid` UI at port 3737.

This is a dev-local tool used by research agents during interactive sessions. It is not a production-facing endpoint.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
