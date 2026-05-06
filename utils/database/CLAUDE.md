# Utils Database

Drizzle ORM client and schema for the system database. `getDb()` returns a singleton Drizzle instance backed by a `postgres.js` connection. `isDatabaseEnabled()` reads `config.yaml` to check if `database.adapter !== 'none'` before opening a connection.

Key files: `client.ts` (connection management), `schema.ts` (Drizzle schema), `resources.ts`, `resource-helpers.ts`, `tags.ts`, `process-dependencies.ts`, `storage.ts` (CRUD helpers), `actions/` (action execution via RPCs).

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
