# agent-youtube/src/state

Persistent local state for the agent-youtube CLI.

- `credentials.ts` — `loadCredentials`, `saveCredentials`, `hasCredentials`: OAuth2 token storage (access token, refresh token, expiry)
- `channel.ts` — `saveChannel`, `loadChannel`: cached channel info (ID, title, handle)
- `quota.ts` — `recordQuotaUsage`, `getQuotaStatus`, `hasQuotaFor`: daily quota tracking with automatic midnight reset

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
