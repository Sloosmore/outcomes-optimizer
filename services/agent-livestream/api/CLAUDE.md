# agent-livestream/api

Vercel serverless function entry point for the agent-livestream BFF. A single-file thin adapter (`index.ts`) that re-exports the named HTTP method handlers from `server/adapters/vercel.ts`.

This file contains no logic of its own — it is the Vercel-required entry point that makes the BFF available as a serverless function under the `/api` path.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
