# Mock Adapter

Implements `CLITarget` for testing without a live AI system. `buildCommand` returns `['echo', <json>]`. `parseOutput` parses the echoed JSON. No preflight or postflight hooks; `validateEnvironment` is a no-op.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
