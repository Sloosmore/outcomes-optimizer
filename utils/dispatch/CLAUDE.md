# Dispatch

Provisioning and launching processes from goals.

## Architecture

Dispatch is intentionally minimal. It does three things:

1. **Provision the worktree** — git worktree with goal.md + config.yaml
2. **Upload goal to DB** — create skill resource + runs link
3. **Launch the loop** — tmux session with `utils/loop/index.ts`

The loop handles everything else: reading goal.md, invoking oversight for decomposition, executing stories, recording epochs.

## Critical Principle: No Special Paths

**Do not add fast paths, pre-seeding logic, or conditional branches to dispatch.** The general optimizer (oversight skill → PRD generation → story execution) is the canonical path for *all* goals.

Why? Because exceptions are where silent failures hide. The March 29, 2026 optimization (commit e9ec81a47) pre-seeded agent-type resources to bypass oversight, thinking it saved time. Instead:

- Regular goals were silently excluded from decomposition entirely
- The loop had no fallback bootstrap code
- The bug went undetected for weeks
- Debugging required tracing through three layers (dispatch.ts → loop → oversight)

The cost was not "latency saved" — it was cognitive complexity + silent failure. Every agent that encounters this code path must ask: "Is this goal decomposed or skipped?" You've made their job harder.

## When You See a Performance Bottleneck

**Option A (right):** Fix it in oversight itself — caching, parallelization, faster model, or add epochs.

**Option B (wrong):** Add a dispatch fast path to skip oversight for certain goals.

Option A compounds. Option B regresses.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
