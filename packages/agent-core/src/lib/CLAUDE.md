# agent-core/src/lib

Shared utilities used across agent-core commands.

- `dispatch-config.ts` — delegates to `readConfig()` from `@duoidal/config` (package `packages/duoidal-config`). Resolution order: `$DUOIDAL_CONFIG` env → `.duoidal/config.json` (CWD) → `~/.duoidal/config.json` → auto-create `{ server: "self" }`. Was previously a standalone resolver; migrated in the config-unification goal to use the shared package.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
