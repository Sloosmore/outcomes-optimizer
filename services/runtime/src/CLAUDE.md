# runtime/src

Core runtime service implementation. Contains the cron poller and the wake scheduler.

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

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
