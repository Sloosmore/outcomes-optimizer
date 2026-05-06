# database/src/services

Data access layer — pure SQL read/write against the Postgres schema via `postgres.js`. No business rules live here; this layer only translates between the application and the database.

Key services:
- `processes.ts` — full lifecycle for `processes` table: init, activate, complete, fail, sleep (segment split), claim, restart, block, amend, epoch tracking
- `resources.ts` — CRUD + link management for `resources` and `resource_links` tables, including checkout/release locking for finite resource types
- `events.ts`, `logs.ts`, `messages.ts`, `metrics.ts`, `traces.ts`, `chats.ts`, `epoch-results.ts` — narrow services for their respective tables
- `project-scope.ts` — project-scoped query filtering via `ENFORCE_PROJECT_SCOPING` constant

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
