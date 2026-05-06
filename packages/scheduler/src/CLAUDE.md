# scheduler/src

Core scheduler implementation. Contains the cron poller and the wake scheduler, extracted from `services/runtime/src/`.

## Module Map

| File | Role |
|---|---|
| `poller.ts` | Cron poller — queries due crons from DB, gates on dependencies and failure limits, dispatches agent runs |
| `poller-service.ts` | DB queries and service types used by the poller |
| `wake-scheduler.ts` | Wake scheduler — queries sleeping processes with past-due `resume_at`, calls `agent-core process resume` for each |
| `poller.test.ts` | Unit tests for poller logic |
| `poller-service.test.ts` | Unit tests for DB service layer |
| `poller.integration.test.ts` | Integration tests requiring a live DB |

## Key Behaviors

**Cron gating.** The poller only dispatches a cron if: the cron's schedule expression fired within the last 5 minutes (`POLL_WINDOW_MS`), all `depends_on` metric keys have a snapshot recorded today, and the `max_dispatches_per_day` limit has not been reached. All three gates must pass before a process is created.

**Failure limit.** If a cron's agent has failed `max_failures_per_day` times today, the poller stops dispatching it until the next calendar day. This prevents retry storms from a broken agent consuming all dispatch capacity.

**Wake scheduler.** Runs independently of the poller. Queries `processes WHERE status='waiting' AND resume_at <= NOW()` and resumes each sleeping process via `npx agent-core process resume`. A process stuck in `waiting` past its `resume_at` indicates the wake scheduler is not running or is failing silently.

## Verification

**Build check:** `cd packages/scheduler && npx tsc --noEmit` — exits 0.

**Unit tests:** `cd packages/scheduler && npm test` — exits 0, 33 tests pass.

**Import boundary:** `grep -r 'import.*from.*utils/dispatch' packages/scheduler/src/` should show only `validateSkillConfig` and `dispatchRun` from `poller.ts`. `grep -r 'import.*from.*utils/cli' packages/scheduler/src/` should return nothing.

**No stale references:** `grep -rn 'services/runtime/src' packages/ utils/ services/ --include='*.ts' --include='*.js'` returns 0 matches.
