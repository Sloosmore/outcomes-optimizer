# agent-events/src/adapters

Contains `SupabaseEventEmitterAdapter` — the only concrete `EventEmitterAdapter` implementation. Emits events as fire-and-forget inserts into the `agent_events` Supabase table. Errors are swallowed and logged rather than thrown, so callers are never blocked by observability failures.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
