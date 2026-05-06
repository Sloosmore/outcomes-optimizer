# agent-events

Shared event types, emitter interfaces, and infrastructure for emitting agent lifecycle events to Supabase. Provides `EventType` constants, `AgentEvent` schema, `createEventService()` factory, `SupabaseEventEmitterAdapter`, and a watchdog that emits `process:stale` when a process goes silent.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
