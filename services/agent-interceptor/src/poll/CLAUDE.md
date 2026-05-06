# src/poll

The event consumer (`consume.ts`) that polls the Cloudflare KV store for pending webhook events and forwards each one to the OpenClaw gateway's `/hooks/agent` endpoint. Designed to run from an OpenClaw cron job, a Node.js script via `tsx`, or any environment with `fetch()` available.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
