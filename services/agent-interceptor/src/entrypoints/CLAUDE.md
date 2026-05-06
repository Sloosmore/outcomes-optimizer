# src/entrypoints

Runtime adapter files that wire the core Hono app to different deployment targets: Cloudflare Workers (`cloudflare.ts`), a bare Node.js server (`node.ts`), and Vercel Edge/Serverless Functions (`vercel.ts`). Each entrypoint constructs a secrets store appropriate for its runtime, instantiates the right event store, and passes both to `createApp`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
