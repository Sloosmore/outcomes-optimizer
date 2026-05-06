# Driver Analysis: agent_efficiency_per_day

**Date**: 2026-04-14
**Analyst**: agent-efficiency metric agent (process <uuid>)
**Baseline**: efficiency=42.728541, HEH=78.8625 hours/day (2026-04-14 00:05:16+00)

---

## Phase 1: Metric Data

**Metric key**: `agent_efficiency_per_day`
**Skill ID**: `<your-skill-resource-id>`
**Current value**: 42.728541 (2026-04-14 00:05:16+00)
**Trend**: volatile — values range from 0.164 (2026-03-15) to 42.73 (today)
**Date range**: 2026-03-15 to 2026-04-14 (25 rows available)

| Date | Value |
|---|---|
| 2026-04-14 | 42.728541 |
| 2026-04-13 | 2.158 |
| 2026-04-11 | 4.6737 |
| 2026-04-10 | 0.7169 |
| 2026-04-09 | 16.064 |
| 2026-04-07 | 11.19 |
| 2026-04-06 | 26.006 |
| 2026-04-05 | 0 |
| 2026-04-04 | 4.378 |
| 2026-04-03 | 7.995 |

The metric is **not rising, falling, or flat** — it is **volatile**: oscillating 10–50x between consecutive days with no clear trend direction.

**Computation path**:
- Cron resource `<your-cron-id>-9ab2-4209-b9ec-7a1ae9f94cd5` (agent-efficiency-cron) triggers every 5 minutes
- It schedules skill resource `<your-skill-resource-id>` (agent-efficiency)
- The poller dispatches an agent worktree; the agent runs `config.content` instructions
- The agent records both `agent_efficiency_per_day` and `human_equivalent_hours_per_day` via `npx agent-core metrics record`

---

## Driver Landscape

**Driver 1: Unspecified diff-measurement method in HEH computation** — The config.content Step 1 instruction says "estimate human_equivalent_hours based on the PR diff size and complexity" and "For each process, estimate human_equivalent_hours" without specifying which git command to use, which base branch to diff against, or whether to exclude `workspace/` artifacts. Different agent sessions produce radically different HEH values from the same 4 processes (...). — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "For each process, estimate human_equivalent_hours based on the PR diff size and complexity."`

**Driver 2: impl_lines_per_hour calibration constant** — The HEH formula divides all non-test added lines by the constant `impl_lines_per_hour: 40`. A human developer writing 40 lines/hour is a conservative rate for boilerplate but high for design work; this value directly scales every HEH estimate by `1/40`. Changing this from 40 to 20 would double HEH and thus double efficiency for any fixed set of processes. — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "impl_lines_per_hour: 40"`

**Driver 3: test_lines_per_hour calibration constant** — The HEH formula divides test file added lines by `test_lines_per_hour: 80`. When test lines are present (e.g., boot/<branch-suffix> had 59 test lines), this constant caps the value of test output. An increase to 40 lines/hour would double test-line contributions to HEH. — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "test_lines_per_hour: 80"`

**Driver 4: min_hours_per_process floor** — Processes producing 0 diff lines receive HEH=0.5 (the floor). On April 13, process `<process-id>` (PR #808) had 0 diff lines and contributed 0.5 HEH / 0.153 agent-hours = 3.27 efficiency. If the floor were raised to 2 hours, that process alone would add 1.5 HEH to the total. — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "min_hours_per_process: 0.5"`

**Driver 5: Process exclusion filter: name NOT LIKE 'cron-%'** — The query excludes cron processes but includes all other completed processes regardless of output quality. Processes like `sandbox-dispatch-*` are excluded by a second filter but other operational processes are included, diluting the efficiency numerator with low-output work. — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "name NOT LIKE 'cron-%'"`

**Driver 6: agent_hours denominator (from process duration)** — The denominator is `SUM(EXTRACT(EPOCH FROM (completed_at - started_at))/3600)`. On April 13, the 4 qualifying processes totaled 1.8457 agent-hours. If processes run faster without producing more output, efficiency rises. If they run slower, efficiency falls. — Artifact: `config.content Step 1 on resource UUID <your-skill-resource-id> — "Compute: efficiency = SUM(human_equivalent_hours) / SUM(EXTRACT(EPOCH FROM (completed_at - started_at))/3600)"`

**Driver 7: Idempotency gate allows re-recording after UTC midnight** — The poller's `shouldDispatch` gate checks `measured_at >= date_trunc('day', NOW())`. If the cron fires multiple times within a UTC day and the agent runs successfully each time, each run overwrites the previous metric with a potentially different HEH value, causing intra-day variance. On April 13, three separate recordings were made (00:05, 23:08, and a cron-only check). — Artifact: `packages/scheduler/src/poller-service.ts:112 — AND measured_at >= date_trunc('day', NOW())`

---

## Categories Checked

| Category | Status | Result |
|---|---|---|
| Computation source errors | Checked | Driver 1 found: config.content Step 1 — unspecified diff-measurement method |
| Input data quality | Checked | Driver 6 found: process duration as denominator from completed_at - started_at |
| Exclusion / filtering logic | Checked | Driver 5 found: cron-% exclusion filter in config.content Step 1 |
| Dispatch / infrastructure failures | Checked | Driver 7 found: poller-service.ts:112 — re-dispatch allowed within same UTC day |
| Prompt / goal specification | Checked | Driver 1 found: config.content Step 1 — open-ended HEH estimation with no measurement protocol |
| External dependencies | Checked | No artifact found — GitHub token not required for git diff; no external dependency gap |
| Reference constants / calibration values | Checked | Drivers 2, 3, 4 found: impl_lines_per_hour:40, test_lines_per_hour:80, min_hours_per_process:0.5 |

---

## Hypothesis Table

| Rank | Driver | Mechanism | Artifact Citation | Impact | Evidence | Tractability | Score | Recommended Experiment |
|---|---|---|---|---|---|---|---|---|
| 1 | Unspecified diff-measurement method | Different agent sessions use different git commands, base branches, and file exclusion rules, producing HEH values that vary 10–50x for identical process sets | config.content Step 1 on UUID <your-skill-id> — "estimate human_equivalent_hours based on the PR diff size" | 5 | 4 | 5 | 100 | Pin the exact command in config.content: `git diff --numstat origin/main..origin/<branch>` excluding workspace/ files; record command used in metric metadata |
| 2 | impl_lines_per_hour calibration | Halving this from 40 to 20 doubles HEH for all processes | config.content Step 1 on UUID <your-skill-id> — "impl_lines_per_hour: 40" | 4 | 5 | 5 | 100 | Change impl_lines_per_hour to 20 and observe HEH doubling; track whether it diverges from actual PR review times |
| 3 | min_hours_per_process floor | Zero-diff processes get 0.5 floor; raising floor increases HEH | config.content Step 1 on UUID <your-skill-id> — "min_hours_per_process: 0.5" | 2 | 5 | 5 | 50 | Set floor to 0 and observe change; compare HEH on days with many zero-diff processes |
| 4 | test_lines_per_hour calibration | Changing from 80 to 40 doubles value of test contributions | config.content Step 1 on UUID <your-skill-id> — "test_lines_per_hour: 80" | 2 | 5 | 5 | 50 | Change test_lines_per_hour to 40 and measure HEH change on days with test-heavy PRs |
| 5 | Intra-day re-recording | Multiple recordings per UTC day overwrite valid earlier values | packages/scheduler/src/poller-service.ts:112 | 3 | 4 | 3 | 36 | Add `uq_metric_snapshots` constraint check; verify only first daily recording persists |
| 6 | Process exclusion filter | Including non-cron, non-sandbox processes regardless of output type dilutes numerator | config.content Step 1 on UUID <your-skill-id> — "name NOT LIKE 'cron-%'" | 2 | 3 | 2 | 12 | Add pr_url IS NOT NULL filter to exclude processes without PRs |
| 7 | Agent hours denominator | Faster processes increase efficiency even with same output | config.content Step 1 on UUID <your-skill-id> — EXTRACT(EPOCH...) | 1 | 3 | 1 | 3 | Run same process twice with different timeouts; measure denominator sensitivity |

---

## Why #1

**Selected: Driver 1 — Unspecified diff-measurement method**

Ranked #1 because: The metric recorded on April 14 (42.728541) is derived from HEH=78.8625, while an independent recomputation using `git diff --numstat origin/main..origin/<branch>` excluding workspace/ files produces HEH=17.05 — a 4.6x discrepancy for the same 4 processes and same formula constants. This means the metric value is not stable across agent sessions: two honest agents reading the same config.content instruction can produce values that differ by 5x. This instability underlies the entire metric's volatility across days.

Rejections:
- Driver 2 (impl_lines_per_hour calibration) is ranked lower because changing it requires human judgment about the correct rate, whereas the diff-method problem has an objective correct answer (a specific git command with defined scope). Also, calibration changes shift the absolute metric value without fixing intra-session variance.
- Driver 3 (min_hours_per_process floor) is ranked lower because the floor applies only to zero-diff processes. On April 13 only 1 of 4 processes hit the floor; its 0.5 HEH contribution is small relative to the 4.6x discrepancy in total HEH observed between computation methods.
- Driver 4 (test_lines_per_hour calibration) is ranked lower because test lines are rare (0 of 3 non-trivial processes on April 13 had test lines in non-workspace paths), making this constant a minor factor in current observed values.
- Driver 5 (process exclusion filter) is ranked lower because cron- and sandbox-dispatch- processes are already excluded; the filter is partially correct. The residual inclusion of operational processes is a refinement, not the root cause of 10x daily swings.
- Driver 6 (intra-day re-recording) is ranked lower because the recorded value at 00:05 is the most recent and presumably reflects the most complete data; the issue is the variance in what gets recorded, not the re-recording mechanism per se.
- Driver 7 (agent hours denominator) is ranked lower because the denominator is mechanically correct (postgres EXTRACT function) and changes with actual process behavior; it does not produce spurious variance the way the HEH numerator does.

---

## Inception Level

```
metric value (42.728541 on 2026-04-14) ← efficiency = HEH / agent_hours = 78.8625 / 1.8457
  ← WHY-1: HEH value (78.8625) was computed by a different method than `git diff --numstat origin/main..origin/<branch>` excluding workspace/ (which yields 17.05) — the gap is 4.6x — Artifact: config.content Step 1 on resource UUID <your-skill-resource-id> — "estimate human_equivalent_hours based on the PR diff size and complexity" (no method specified)
    ← WHY-2: The config.content does not specify which git command to use, whether to include workspace/ files, or which base ref to compare against. Different agents therefore use different approaches (git diff vs gh api, including vs excluding workspace, different --numstat arguments), producing structurally incomparable outputs — Artifact: config.content Step 1 on resource UUID <your-skill-resource-id> — the full Step 1 text contains the formula constants but no command protocol
      ← WHY-3: The config.content was authored as a natural-language goal description (not as an executable script), so agents must interpret instructions like "estimate human_equivalent_hours based on the PR diff size and complexity." This leaves four free variables: (a) which git subcommand (diff vs log vs show), (b) which numstat flags, (c) which base ref (origin/main, HEAD, or merge-base), (d) whether to exclude workspace/ artifacts. Different agents resolve each free variable independently — no artifact pins them — Artifact: config.content Step 1 on resource UUID <your-skill-resource-id> — no shell command or flag pattern present in that step
        ← ROOT: The config.content instruction is the single source that every agent executing this skill reads. Without a pinned command, agents exercise discretion, producing values that cannot be compared day over day. The fix point is adding a concrete command to config.content Step 1.

CONFIDENCE: high
CONFIDENCE REASON: Two independent computations of April 13 HEH using the same formula but different diff methods produce 17.05 vs 78.86 — a 4.6x discrepancy that directly explains why the metric is volatile across sessions.
```
