# database/src

Source root for the `@skill-networks/database` package.

- `client.ts` — Postgres client factory (postgres.js connection from env vars)
- `drizzle.ts` — Drizzle ORM instance for schema-level operations
- `constants.ts` — shared constants (`ENFORCE_PROJECT_SCOPING`, `getSupabaseUrl()`, `getSupabaseAnonKey()`, `getSupabaseServiceKey()` — all env-driven, throw if unset)
- `index.ts` — package public surface: re-exports all services and action types
- `actions/` — Supabase RPC action dispatch layer (see `actions/CLAUDE.md`)
- `services/` — SQL read/write services (see `services/CLAUDE.md`)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
