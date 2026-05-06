# agent-hooks/src/commands

Contains two files:

- **handle-utils.ts** — `HandlerConfigSchema` (Zod schema for hook config JSON) and `evaluateCondition()` (condition string evaluator supporting `>`, `>=`, `<`, `<=`, `==`, `!=` operators with prototype-pollution protection)
- **handle.ts** — `handleCommand()` stub (not yet implemented; throws `Error("handleCommand is not yet implemented")`) and re-exports from `handle-utils.ts`

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
