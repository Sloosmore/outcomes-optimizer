# agent-livestream/server/adapters

Runtime entry-point adapters for the agent-livestream BFF server. Three files:
- `node.ts` — Node.js HTTP server entry (Hono + node-server)
- `vercel.ts` — Vercel serverless adapter (re-exports Hono app as named HTTP method handlers)
- `deploy.ts` — Deployment utility script

The `research/` subdirectory contains the ClaudeCodeSDK and SSH adapters for OpenClaw research routing.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
