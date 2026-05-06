# runtime/openclaw/config

Contains `openclaw.json` — the primary configuration file for the openclaw agent runtime.

## Key Settings

- `agents.defaults.model.primary` — the model used for all dispatched agents (currently `anthropic/claude-sonnet-4-6`)
- `agents.defaults.maxConcurrent` — maximum concurrent top-level agent processes (4)
- `agents.defaults.subagents.maxConcurrent` — maximum concurrent subagent processes per parent (8)
- `gateway.port` — the port openclaw's HTTP gateway listens on (18789)
- `gateway.auth.token` — gateway auth token, resolved from `OPENCLAW_GATEWAY_TOKEN` env var at runtime
- `gateway.trustedProxies` — IP allowlist for reverse proxy trust

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
