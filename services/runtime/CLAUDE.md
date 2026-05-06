# Runtime Service

## Scheduler Extraction

**Scheduler extraction:** The cron poller and wake-scheduler TypeScript source has been moved to `packages/scheduler/`. The runtime container now runs these scripts from `packages/scheduler/src/`. See `packages/scheduler/CLAUDE.md` for verification instructions.

## Skill Instructions

**`config.content` is the source of truth for skill instructions.** The poller reads `skill_config.content` to build the prompt sent to `claude -p`. Never set `config.prompt` on a skill resource — it will be ignored. If a cron fires and the skill has no `content`, the poller falls back to the cron's own `config.prompt` (legacy only).

## Container Operations

**Always confirm before restarting or recreating the runtime container.** `docker compose up --force-recreate` wipes `/root/dispatch/` and all in-progress worktrees — active dispatch loops are destroyed with no recovery path. State what will happen, get confirmation, then proceed.

## The Idempotent Cron Agent Pattern

This is the most important high-level pattern in the codebase. Every agent that runs on a cron schedule (agent-efficiency, agent-hours, developer-leverage, prod-failures, and any future metric agents) uses this pattern. Understanding it is required before touching the runtime service, the poller, or any cron-triggered skill.

**The pattern:**

An agent is registered as a cron skill — it fires on a schedule (typically daily). When it fires, the poller creates a process, dispatches it, and the agent runs. The agent's job is to collect a measurement, record a metric snapshot, and decide what action to take next.

The critical property is **idempotency through data deletion**. The observer (typically a human or a higher-level agent) can reset the system to a known state by deleting the metric snapshot or process record for today. When the cron fires again — or when the observer triggers a manual re-run — the agent finds no data for today, treats it as a fresh start, and re-runs from scratch. This is the idempotent gate: the absence of today's data is the signal to act.

**The full cycle:**
1. Cron fires → poller creates process → agent activates with status=active
2. Agent checks for today's metric snapshot — if it exists, the run is a no-op (idempotent gate prevents double-counting)
3. If no snapshot exists, agent collects the measurement (queries DB, calls APIs, reads logs)
4. Agent records the snapshot via `npx agent-core metrics record`
5. Agent decides what to do with the data — if a threshold is crossed, it dispatches a child skill (oversight, prod-failures, etc.)
6. Agent marks itself complete and exits

**Why this pattern matters for verification:** the idempotent gate means you can test the full cycle by deleting today's data and triggering a re-run. The re-run must behave identically to the original run — same measurement, same threshold logic, same child dispatches if applicable. A re-run that produces a different result indicates the agent is not truly idempotent and is reading mutable state it shouldn't depend on.

**The observer's role:** in the multi-level pattern, the observer triggers the cron agent (or deletes its data to force a re-run), then watches the DB for the snapshot row to appear, the child processes to be dispatched, and the agent to complete. Because everything is on the same server, the observer has direct visibility into the agent's worktree and can read its progress without waiting for it to report back. The observer is the quality gate — it confirms the full cycle completed correctly before considering the change verified.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
