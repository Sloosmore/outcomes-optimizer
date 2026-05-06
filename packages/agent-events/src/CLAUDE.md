# agent-events/src

Core source for the `agent-events` package. Exports:

- **event-types.ts** — `EventType` constants (stable string values; changing them breaks historical DB queries)
- **schemas.ts** — Zod schemas for `AgentEvent`, `Resource`, `ResourceLink`
- **interfaces.ts** — `EventEmitterAdapter`, `EventStreamAdapter`, `EventHistoryAdapter`, `GraphDataAdapter` interfaces
- **event-service.ts** — `createEventService()` factory: reads env vars, returns a `PrefilledEventEmitterAdapter` or `null` if any required var is absent
- **watchdog.ts** — `createWatchdog()`: subscribes to realtime Supabase changes for a process; emits `process:stale` if no events arrive within `thresholdMs`
- **adapters/** — concrete adapter implementations (currently Supabase only)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
