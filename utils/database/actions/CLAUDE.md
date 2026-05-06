# Database Actions

Re-exports `executeAction` from `packages/database/src/actions/execute-action.ts` for backwards compatibility. All ontology writes (creating/linking resources) must go through `executeAction(name, input, client)`, which calls a Postgres RPC registered in `action_types` for atomicity.

Do not write inline `supabase.from('resources').insert(...)` calls — use `executeAction` instead.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
