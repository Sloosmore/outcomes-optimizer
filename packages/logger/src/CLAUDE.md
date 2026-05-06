# logger/src

Core logger implementation. All logging infrastructure lives in this single file (`index.ts`). The module is the shared foundation for every service in this repository — agent-interceptor, credential-proxy, agent-livestream, and all runtime services depend on it transitively.

## Design

**Module-level drain registry.** A singleton `drains` array holds all registered `DrainAdapter` instances. `ConsoleDrain` is always present. `DatabaseDrain` is registered at startup by consumers that have DB access — the logger itself never imports from the database, preserving its usability in lightweight contexts.

**Fire-and-forget writes.** `log()` dispatches to all drains concurrently and never awaits them. Drain errors are swallowed and written to stderr with rate limiting (one error logged per window, then every 100th). A drain failure never propagates to the caller.

**Level filtering.** `_minLevel` gates all writes. Entries below the configured level are discarded before any drain is called. `LOG_LEVEL` env var sets the level at startup; production defaults to `info`, development to `debug`.

**Structural boundary.** `DatabaseDrain` is defined here (not in a separate DB package) to avoid circular dependencies — but it takes its DB client as injected dependencies, not as a direct import. This means the logger module itself has zero database imports.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
