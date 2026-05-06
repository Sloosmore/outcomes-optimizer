# agent-core

CLI for managing agent processes (campaigns). Provides commands for creating, monitoring, and controlling the lifecycle of agent processes tracked in the database.

## Installation

Pre-installed. Invoke via:

```bash
npx agent-core --help
```

## Commands

### process init

Create a new process. Re-running with the same name creates a distinct row. Prints the new process UUID to stdout.

```bash
npx agent-core process init \
  --name "my-run-v1" \
  --skill-resource-id <uuid> \
  --run-type local
```

Options: `--name`, `--branch`, `--run-type` (cloud|local|moltbot), `--skill-resource-id`, `--unlinked`, `--training-set-id`, `--channel-id`, `--queued`, `--prompt`, `--parent-process-id`

### process status

Read current process state from the database.

```bash
npx agent-core process status --id <uuid>
npx agent-core process status --name "my-run-v1" --json
```

### process restart

Restart a killed or failed process by creating a linked child process. This is the **canonical way to resume a dead process**.

```bash
npx agent-core process restart --id <dead-process-uuid>
```

The command:
1. Validates the target process is in `failed` or `completed` status
2. Creates a new child process linked via `parent_process_id` and `root_process_id`
3. Copies `skill_resource_id` from the dead process
4. Emits `process_continued` and `process_born_from` agent events
5. Prints the new process UUID to stdout

**Manual process resurrection (manually inserting rows, wiring `parent_process_id` by hand, or copying IDs outside this command) is not supported.** Always use `npx agent-core process restart` to continue a killed or failed process.

### process amend

Append text to the process goal file and sync it to the database.

```bash
npx agent-core process amend --id <uuid> --append "Additional requirement: ..."
```

### process record

Upload epoch results from `workspace/epochs/` to the database.

```bash
npx agent-core process record --id <uuid> --workspace ./workspace
npx agent-core process record --id <uuid> --epoch 3   # single epoch only
```

### process sleep

Put the current process to sleep until a future time (requires `EVAL_PROCESS_ID`, `WORKTREE_PATH`, `LOOP_CMD` env vars).

```bash
npx agent-core process sleep --interval "30 minutes"
npx agent-core process sleep --interval "2 hours"
```

### process resume

Resume a sleeping process that has passed its `resume_at` time.

```bash
npx agent-core process resume --id <uuid>
```

### process complete / fail / active / reset

Lifecycle transitions:

```bash
npx agent-core process complete --id <uuid>
npx agent-core process fail     --id <uuid> --reason "timed out"
npx agent-core process active   --id <uuid>
npx agent-core process reset    --id <uuid>   # back to pending
```

### process update

Update mutable fields on an existing process.

```bash
npx agent-core process update --id <uuid> --channel-id <uuid>
npx agent-core process update --id <uuid> --worktree-path /abs/path/to/worktree
```

## Environment Variables

| Variable | Description |
|---|---|
| `EVAL_PROCESS_ID` | Current process UUID (used by `complete`, `fail`, `sleep`, `resume`) |
| `WORKTREE_PATH` | Absolute path to the process worktree (required by `sleep`) |
| `LOOP_CMD` | Command used to re-launch the agent loop (required by `sleep`) |
| `DATABASE_URL` | Postgres connection string |

`EVAL_CAMPAIGN_ID` is a deprecated alias for `EVAL_PROCESS_ID`; a warning is emitted when it is used.

## Process Restart vs Reset

| Command | When to use |
|---|---|
| `process restart` | Create a new child process that continues from a dead one (failed or completed). Preserves lineage via `parent_process_id`. |
| `process reset` | Reset a failed process back to `pending` so the same row can be re-dispatched. Does not create a new process. |

## Lint Enforcement

`packages/agent-core/eslint.rules.js` registers per-package ESLint rules that prevent regressions from the DB unification refactor.

Rules scoped to `src/commands/**/*.ts`:
- **No direct service instantiation** — `new ResourcesService(...)`, `new ProcessesService(...)`, `new MetricsService(...)`, `new EventsService(...)` are banned. Use `getAdapter()` (scoped) or `getUnscopedAdapter()` (admin escape hatch) instead.
- **No raw SQL** — `sql\`...\`` tagged template expressions are banned. Use adapter/service methods from `packages/database`. Any exception must have an `eslint-disable` with a justification comment.
- **No console.error/warn** — structured logging required in commands. `console.log` is allowed for stdout CLI output.
- **No empty catch blocks** — silent error swallowing hides bugs.

## Testing

> **State-based decision modules — `routeToServer` and `readDispatchConfig` — must be tested against real inputs, not mocked.** Stub only at the I/O boundary (`child_process.spawnSync`, `fs`, env). See the root `CLAUDE.md` "Testing State-Based Modules" section for the principle. `__tests__/waypoint-router.test.ts` is the canonical exercise of `routeToServer`; if you mock `routeToServer` in `execute.test.ts` (or anywhere else), you are only testing call shape — the routing contract has its own dedicated suite.

Unit tests run without any database:

```bash
npx vitest run packages/agent-core
```

Integration tests require `RUN_INTEGRATION=true` and a live `DATABASE_URL`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
