# agent-livestream/server/middleware

Hono middleware stack for the agent-livestream BFF server:

- `jwt.ts` — JWT verification middleware supporting both JWKS (production, via `SUPABASE_URL`) and HS256 secret (local dev, via `SUPABASE_JWT_SECRET`). Throws on startup in production if neither is configured.
- `rate-limit.ts` — IP-based rate limiter with configurable window and max-requests thresholds.
- `provision-secret.ts` — Middleware that resolves per-request credential injection for proxied tool calls.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
