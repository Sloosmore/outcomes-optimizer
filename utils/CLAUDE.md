# Utils

Scaffolding for outcomes-optimizer. This is where context engineering happens and experiments run. The `config.yaml` at repo root drives all behavior here.

> **Services do not belong here.** If it runs as a process, exposes an HTTP endpoint, connects to external infrastructure, or has its own lifecycle — it is a service and lives in `services/`. `utils/` is for pure loop infrastructure: the epoch orchestrator, run harness, database schema, config loading, and shared types. Nothing in `utils/` should have a `main()`, start a server, or be deployed independently.

## Documentation

See `../docs/utils/` for component documentation:

| Doc | Status | Description |
|-----|--------|-------------|
| [config.md](../docs/utils/config.md) | Implemented | YAML config loading with Zod |
| [database.md](../docs/utils/database.md) | Implemented | PostgreSQL schema (Drizzle) |
| [linter.md](../docs/utils/linter.md) | Removed | SKILL.md validation (deleted) |
| [traces.md](../docs/utils/traces.md) | Removed | CLI trace processing (deleted) |

## Testing

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
```

**Conventions:**
- Test files: `foo.ts` -> `__tests__/foo.test.ts`
- Integration tests: `foo.integration.test.ts` (for tests that use external services, file system, or full system flows)
- Fixtures: `__tests__/fixtures/`
- **No vitest imports needed** - `globals: true` in vitest config exposes `describe`, `it`, `expect`, `beforeEach`, `afterEach`, `vi` globally
- Mock git and network; filesystem mocking optional for file I/O tests
- Use `tmpdir()` for test artifacts, not project directory (isolation, no cleanup issues)
- Save and restore global state (env vars, folders, etc.) - tests must clean up after themselves
- **We should never have failing tests** - All tests must pass before committing changes

## Principles

- When updating this file, just add a bullet - do not add whole sections
- **Config-driven** - `config.yaml` determines CLI adapter, database mode, experiment name
- **Testable** - Pure functions, injected dependencies
- **CLI-agnostic** - Works with Claude Code, Codex, or manual
- **No TODOs** - Full implementation or don't write the file
- **Constants in types.ts** - Import shared constants from `utils/types.ts`; package-specific constants go in `<package>/types.ts`
- **Never have silent errors** - All caught errors must be logged or surfaced; empty catch blocks are forbidden
- **CRUD under database/** - All training set/data CRUD lives in `utils/database/`
- **Ontology writes use executeAction** - Any code that creates or links resources in the ontology must call `executeAction(name, input, client)` from `utils/database/actions/execute-action.ts`. Actions are registered in the `action_types` table (see `supabase/migrations/20260329000001_action_registry.sql`) and each is backed by a Postgres RPC for atomicity. Never write inline `supabase.from('resources').insert(...)` calls in route handlers or services — call an action instead.
- **Database schema changes** — See `docs/utils/database.md` for RLS policies, Drizzle migration rules, and DDL workflow.
- **`config.content` is the canonical skill instruction field** — all skill resources store their instructions in `config.content`. Never read or write `config.prompt` on a skill resource; `CronSkillConfig` uses `content`, `validateSkillConfig` checks `content`, and every dispatch path (worktree provisioner, inline runner, CLI) reads `content`. The `prompt` field is only valid on cron resources as a last-resort fallback.
- **Dispatch optimization is fragile — do not tamper with it** — The general optimizer (oversight skill decomposition) is the canonical path for all goals. Never add special-case fast paths, pre-seeding logic, or conditional branches that bypass oversight for certain goal types. The March 29 optimization silently broke regular goal decomposition for weeks by pre-seeding only agent-type resources — the loop had no fallback code. If you see a performance bottleneck in dispatch, fix it in oversight itself (caching, parallelization, faster model) or add epochs — never patch dispatch to skip the general optimizer. Single code path beats every optimization.

---

## Verification

### @anthropic-ai/sdk hoist in worktrees

**Check:** If the `claude-agent-sdk` adapter throws `MODULE_NOT_FOUND` on `@anthropic-ai/sdk` inside a worktree, the hoisted version in `utils/package.json` has drifted from `@anthropic-ai/claude-agent-sdk`'s declared requirement.

**How to run:** `node -e "require('@anthropic-ai/sdk')"` inside a worktree's node context. Success = no error; failure = version range mismatch.

**Why it can't be gamed:** It tests the actual module resolution path that the adapter uses at runtime — not a unit test mock. A passing unit test won't catch a missing or mismatched hoist.

---

**Future config options**: Track planned `config.yaml` additions in the "FUTURE CONFIG OPTIONS" section at the bottom of `config.yaml`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
