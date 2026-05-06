# agent-hooks/src

Root source for the `agent-hooks` package. Exports `handleCommand`, `HandlerConfigSchema`, `evaluateCondition`, and the `HandlerConfig` type from `commands/handle.ts` and `commands/handle-utils.ts`.

`handleCommand` is not yet implemented — it throws immediately. `HandlerConfigSchema` validates hook config JSON files (stored under `workspace/hooks/<resource-id>/config.json`), and `evaluateCondition` parses and evaluates condition strings in the form `payload.some.path > 100`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
