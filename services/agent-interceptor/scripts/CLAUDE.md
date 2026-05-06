# scripts

Operational scripts for the agent-interceptor service. Currently: `secrets-sync.sh`, which diffs current Doppler secrets against a locally-stored checksum file and only calls `wrangler secret bulk` when something actually changed. This avoids unnecessary Worker redeploys — each `wrangler secret bulk` triggers a full redeploy and Durable Object reset.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
