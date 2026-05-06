# src/store

The event persistence layer. Defines the `EventStore` interface and two implementations: `KVEventStore` (Cloudflare Workers KV, production) and `MemoryEventStore` (in-memory, local dev and Vercel). The `ulid.ts` module generates time-sortable IDs for events. `types.ts` re-exports the `WebhookEvent` contract from `contract.ts`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
