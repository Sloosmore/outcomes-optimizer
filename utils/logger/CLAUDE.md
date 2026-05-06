# Utils Logger

Structured logger with a drain-based architecture. `createLogger(service)` returns a `Logger` with `debug/info/warn/error` methods. Each log call constructs a `LogEntry` and fans it out to all registered drains. The default drain is `ConsoleDrain`, which writes JSON to `stderr`.

Additional drains are registered via `registerDrain(drain)`. `_resetDrains()` is available for testing to restore the default state.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
