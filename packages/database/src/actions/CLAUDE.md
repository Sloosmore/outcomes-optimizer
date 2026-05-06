# database/src/actions

Action execution layer — the boundary between application code and the database for all write operations that carry business rules.

- `execute-action.ts` — the core dispatcher: fetches `action_types` rows, validates input via AJV JSON Schema, enforces `validation_rules.uniqueness`, maps camelCase params to snake_case RPC params, calls the Postgres RPC, maps results back, and writes an audit row to `action_events`.
- `index.ts` — re-exports `executeAction` plus `listActions` and `describeAction` helpers.

All write-time business rules live in the `action_types` table, not in code here. This file only knows how to dispatch — not what the rules are.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
