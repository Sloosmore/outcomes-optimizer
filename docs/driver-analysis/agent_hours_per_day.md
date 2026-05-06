# Driver Analysis: `agent_hours_per_day`

**Metric:** `agent_hours_per_day`
**Analyzed:** 2026-04-13
**Yesterday's value (2026-04-12):** 1.5477 hours (1 process: <process-id>, 22:57:49–00:30:41 UTC next day)

**Metric definition:** SUM of wall-clock hours for all completed non-cron processes started on the prior calendar day, computed as `SUM(EXTRACT(EPOCH FROM (completed_at - started_at))/3600)` over `processes WHERE status='completed' AND DATE(started_at) = CURRENT_DATE - 1 AND completed_at IS NOT NULL AND name NOT LIKE 'cron-%'`.

---

## 1. Hypothesis Table

| Driver | Mechanism | Artifact Citation | Impact | Evidence | Tractability | Score | Experiment |
|--------|-----------|------------------|--------|----------|--------------|-------|-----------|
| Stuck/long-running processes (...) | Processes that hang or never receive a COMPLETE signal run until an implicit ~24h wall-clock cutoff, each contributing 24+ hours to the metric | `processes.started_at` / `processes.completed_at` / `processes.current_epoch`; `utils/loop/CLAUDE.md` (watchdog emits PROCESS_STALE after 15 min of silence but is not documented as terminating the process) | 5 | 5 | 3 | 75 | Deploy an explicit process wall-clock timeout (e.g., 4h); compare daily hours before/after on historically high-spike days |
| Number of dispatches per day | Each dispatched non-cron process contributes its full duration; more dispatches multiply total hours additively | `processes.name` / `processes.run_type` / `processes.root_process_id` | 4 | 5 | 4 | 80 | Hold goal complexity constant; vary dispatch volume; measure resulting total hours per day |
| Epoch duration (LLM complexity/prompt length) | Longer prompts and more complex goals cause each epoch to run longer; wall-clock per epoch is recorded in epoch_results.duration_ms | `epoch_results.duration_ms` / `epoch_results.cost`; `utils/loop/orchestrator.sh:175` (claude invoked once per epoch) | 4 | 4 | 3 | 48 | Fix goal type; vary prompt length; measure epoch_results.duration_ms distribution across epochs |
| Process lifecycle overhead (inter-epoch and post-epoch) | Non-epoch overhead accumulates in two phases: inter-epoch orchestrator bookkeeping between consecutive epochs, and postflight steps (git commit, DB writes, skill sync) after the final epoch before processes.completed_at is recorded | `processes.completed_at`; `utils/run/index.ts:44` (runPostflight); `utils/run/index.ts:30` (syncSkills) | 2 | 4 | 4 | 32 | Compare sum of epoch_results.duration_ms to process wall-clock duration; gap = infrastructure overhead |
| Metric query exclusion/filtering logic | The name NOT LIKE 'cron-%' filter could incorrectly include or exclude processes, inflating or deflating the reported metric | `processes.name` / `processes.status` | 1 | 5 | 5 | 25 | Audit all process names against the filter; verify cron processes are excluded; check for misnamed processes |
| External dependency delays (rate limits, API slowdowns) | Rate-limited epochs pause until retry succeeds, adding latency inside an epoch; executor falls back to secondary model | `utils/run/executor.ts:12` (rate-limit detection); `utils/run/executor.ts:184` (retry on rate limit); `utils/run/executor.ts:195` (both-models-rate-limited annotation) | 2 | 2 | 3 | 12 | Correlate epoch_results.duration_ms outliers with rate-limit log entries in workspace epoch logs |
| Goal specification quality (vague goals → more epochs) | Poorly specified goals cause agents to iterate through more epochs before emitting COMPLETE, multiplying total duration | `resources.config->>'epochs' on <uuid>` (max 10 epochs); `utils/loop/orchestrator.sh:6` (--max-epochs default 10) | 3 | 2 | 3 | 18 | Compare epoch counts for clearly-specified vs. vague goals; measure correlation with total process hours |

_Note: Score ranks experimental priority for isolated-factor experiments. Primary driver selection (§3) uses causal primacy and may differ from the score ranking._

---

## 2. Driver Landscape

### D1: Stuck/Long-Running Processes (Timeout Mechanism)

The most dramatic driver in the dataset. On 2026-04-11, three processes each ran for approximately 24.2 hours:

- `<process-id>`: 24.2266 h, `processes.current_epoch` = 4
- `<process-id>`: 24.2413 h, `processes.current_epoch` = 3
- `<process-id>`: 24.2535 h, `processes.current_epoch` = 0

The near-identical ~24.2h durations across all three processes — despite different epoch counts — strongly indicate a shared wall-clock timeout mechanism rather than organic process completion. A process that completed organically after epoch exhaustion would have current_epoch near 10 (the configured maximum). A process with current_epoch=0 that ran for 24.2h spent almost no time in epochs; it stalled in infrastructure before its first epoch was recorded.

The `utils/loop/CLAUDE.md` documents that a watchdog emits `PROCESS_STALE` after 15 minutes of silence. However, the watchdog is described as emitting an event, not terminating the process. This gap — signal without enforcement — explains how a process can silently stall for hours before an external mechanism (infrastructure timeout, scheduler sweep) eventually resolves `processes.completed_at` near the 24-hour mark.

Total for Apr 11: 72.721 hours, driven entirely by this failure mode across 3 processes.

**Citations:** `processes.started_at` / `processes.completed_at` / `processes.current_epoch` (processes table schema); `utils/loop/CLAUDE.md` (watchdog behavior: "Starts a watchdog that emits PROCESS_STALE after 15 minutes of silence").

### D2: Number of Dispatches Per Day

On 2026-04-09, 51 non-cron processes ran, totaling 57.882 hours. Most were short test runs (< 0.01h each), but several long goal processes drove the bulk of hours: `goal-end` = 8.0h, `<short-id>` = 5.42h, `<short-id>` = 4.84h, `<short-id>` = 4.70h. Dispatch volume amplifies whatever the per-process average is: even with many short processes, a handful of long ones dominates the sum.

On quiet days the binding constraint is dispatch volume regardless of per-process duration. Apr 5 (0.353h) and Apr 12 (1.548h, 1 process) illustrate that low dispatch counts cap the metric absolutely. Dispatch volume and stuck-process duration are multiplicative: a day with 51 dispatches and one stuck process would generate far more hours than Apr 11's 3-process day.

**Citations:** `processes.name` / `processes.started_at` / `processes.completed_at` / `processes.status` (processes table schema); `resources.config->>'goal_metric' on <uuid>`.

### D3: Epoch Duration (LLM Complexity/Prompt Length)

Each epoch spawns a Claude Code CLI invocation via `utils/loop/orchestrator.sh:175`. Epoch wall-clock time is recorded in `epoch_results.duration_ms`. For process <process-id> on 2026-04-12:

- Epoch 1: 2,819,389 ms (47 min), cost $15.76 — `epoch_results.duration_ms` / `epoch_results.cost`
- Epoch 2: 728,916 ms (12 min), cost $3.59 — `epoch_results.duration_ms` / `epoch_results.cost`

The ~3.9x duration and ~4.4x cost difference between epoch 1 and epoch 2 within the same process confirms that per-epoch variance is high, and that cost correlates with duration (implying LLM compute, not infrastructure wait, drives epoch length). The prompt assembled per epoch at `utils/loop/orchestrator.sh:128–180` includes goal content, optimization framework, and test sets — prompt complexity directly governs epoch duration.

**Citations:** `epoch_results.duration_ms` / `epoch_results.cost` / `epoch_results.epoch_number` / `epoch_results.started_at` (epoch_results table schema); `utils/loop/orchestrator.sh:175` (claude invocation per epoch); `utils/loop/orchestrator.sh:6` (--max-epochs flag).

### D4: Process Lifecycle Overhead (Inter-Epoch and Post-Epoch)

For process <process-id>, the total wall-clock duration (22:57:49 start → 00:30:41 completed_at) is 92.9 minutes. Epoch wall-clock accounts for 47 + 12 = 59 minutes. The remaining ~34 minutes are non-epoch overhead, distributed across the process lifecycle:

- **Inter-epoch gap (~13 min):** Epoch 1 ended at approximately 23:44 UTC; epoch 2 began at 23:57 UTC. This inter-epoch interval covers orchestrator bookkeeping between epochs (epoch result recording, prd.json update, thrashing check).
- **Post-epoch overhead (~21 min):** Epoch 2 ended at approximately 00:09 UTC; `processes.completed_at` was recorded at 00:30 UTC. This gap covers postflight steps at `utils/run/index.ts:44` (`runPostflight`), including git operations, database writes, and skill synchronization (`utils/run/index.ts:30`, syncSkills call).

Total non-epoch overhead is ~34 minutes (~37% of the 1.5477h process), which is significant for cost accounting but not the driver of multi-hour variance. On the Apr 11 spike days, 34 minutes of overhead is negligible against 24.2h stuck processes.

**Citations:** `processes.completed_at` (processes table schema); `utils/run/index.ts:44` (runPostflight call); `utils/run/index.ts:30` (syncSkills call); `epoch_results.started_at` (epoch_results table schema).

### D5: Metric Query Exclusion/Filtering Logic

The metric filters `status='completed'`, `completed_at IS NOT NULL`, and `name NOT LIKE 'cron-%'`. The cron exclusion correctly removes cron processes, which are noted to fail in under 1 second and would contribute negligible time regardless. The `processes.name` column carries this distinction. The `completed_at IS NOT NULL` guard prevents NULL arithmetic. No evidence in the 8-day historical dataset (2026-04-05 through 2026-04-12) suggests the filter is misclassifying processes — values are coherent with known activity levels across all 8 days. This driver is a hygiene check, not an active source of variance.

**Citations:** `processes.name` / `processes.status` / `processes.completed_at` (processes table schema).

### D6: External Dependency Delays (Rate Limits, API Slowdowns)

The run executor at `utils/run/executor.ts:12` detects rate limits by scanning stdout/stderr for known patterns via `RATE_LIMIT_PATTERNS`. When rate-limited, `utils/run/executor.ts:184` retries with a fallback model. `utils/run/executor.ts:195` handles the case where both primary and fallback models are rate-limited, annotating the result. The OAuth token routing at `utils/run/executor.ts:44` also routes credentials to the correct env var for Claude Code.

Rate limit delays would manifest as elongated `epoch_results.duration_ms` values. The Apr 11 uniformity (~24.2h each across three independent processes) is inconsistent with rate-limit stochasticity. Rate limits affect individual epoch calls, not the 24-hour process lifecycle. The retry logic at `utils/run/executor.ts:184` limits, rather than extends, total duration by falling back to an alternative model.

**Citations:** `utils/run/executor.ts:12` (rate-limit detection); `utils/run/executor.ts:184` (retry branch); `utils/run/executor.ts:195` (both-models-rate-limited annotation).

### D7: Goal Specification Quality (Vague Goals → More Epochs)

Vague or underspecified goals could cause agents to iterate through more epochs without converging, pushing total duration toward `MAX_EPOCHS × avg_epoch_duration`. The skill resource is configured with `epochs: 10` (`resources.config->>'epochs' on <uuid>`). The orchestrator also implements thrashing detection at `utils/loop/orchestrator.sh:195`: if prd.json does not change for 3 consecutive epochs, it aborts.

However, the Apr 11 stuck processes had `processes.current_epoch` values of 0, 3, and 4 — none near the 10-epoch maximum. This rules out epoch-exhaustion from vague goals as the cause of those 24h durations. Goal quality remains a plausible secondary driver for moderately long runs but cannot explain the highest-variance events in the dataset.

**Citations:** `resources.config->>'epochs' on <uuid>`; `utils/loop/orchestrator.sh:195` (thrashing detection: "ERROR: 3 epochs with no progress. Possible thrashing. Aborting."); `processes.current_epoch` (processes table schema).

---

## 3. Why #1

_Analysis window: 2026-04-05 through 2026-04-12 (8 days). The header above reflects yesterday's value (Apr 12); driver selection is based on the full 8-day window, where Apr 11 (72.721h) is the highest-variance event._

**Selected driver: Stuck/Long-Running Processes (Timeout Mechanism)**

The Apr 11 spike of 72.721 hours — the largest in the 8-day dataset — is explained entirely by three processes each contributing ~24.2 hours. The uniformity of duration across processes with different epoch counts (0, 3, 4) is diagnostic: organic completion produces varied durations proportional to work done; a shared wall-clock timeout produces nearly identical cutoff times. No other driver produces this signature.

**Rejections by name:**

- **Number of dispatches per day:** Ranked first by score (80) and clearly acts as a multiplier — but on Apr 11 only 3 processes ran (`processes.name` / `processes.status` confirm 3 completed non-cron processes) yet the total was 72.72h. Dispatch volume cannot explain that day without the stuck-process mechanism operating on each process. The stuck-process driver is selected as #1 on causal primacy: its signature (uniform ~24.2h durations across independent processes) is uniquely diagnostic. Eliminating it on a day like Apr 11 (3 stuck processes × ~24.2h = 72.7h) would reduce to 3 × ~1.5h (typical non-stuck duration, per the <process-id> benchmark) = ~4.5h — a ~16x reduction. Eliminating dispatch volume alone would reduce hours proportionally but leaves the stuck-process failure mode intact. Rejected as primary driver; it is secondary and amplifying.

- **Epoch duration (LLM complexity/prompt length):** Explains within-process variance (47 min vs. 12 min for <process-id> epochs), but cannot explain 24-hour process durations for processes with current_epoch values of 0–4. An epoch running long would appear in epoch_results.duration_ms; processes that stall outside epochs produce no epoch records for those stalled periods. Rejected.

- **Process lifecycle overhead (inter-epoch and post-epoch):** Total non-epoch overhead for <process-id> is ~34 minutes (inter-epoch ~13 min + post-epoch ~21 min from epoch 2 end at ~00:09 UTC to `processes.completed_at` at 00:30 UTC). Even a 10x amplification of this overhead would not produce 24h processes. The overhead is additive to epoch time, not a loop that can run indefinitely. Rejected.

- **Metric query exclusion/filtering logic:** No evidence of misclassification across 8 days of data — metric values are coherent with known activity levels, and the `name NOT LIKE 'cron-%'` filter is consistent with the observed process name patterns (`processes.name` / `processes.status`). The filter is consistent and correct. Rejected.

- **External dependency delays (rate limits, API slowdowns):** The executor's retry logic at `utils/run/executor.ts:184` contains, rather than extends, delays by switching models. Rate-limit events are stochastic and produce varied, bounded delays — not the uniform ~24.2h signature seen on Apr 11. Rejected.

- **Goal specification quality (vague goals → more epochs):** Ruled out by low epoch counts on the Apr 11 stuck processes (...). A vague-goal process exhausting all epochs would show current_epoch near 10. Rejected.

---

## 4. Inception Level

- **WHY-1:** The metric value on Apr 11 was 72.721 hours — the highest in the 8-day dataset — driven by three processes (...) each contributing approximately 24.2 hours to `processes.completed_at - processes.started_at`.

- **WHY-2:** Each of the three processes ran for ~24.2 hours regardless of how many epochs they completed (0, 3, and 4 respectively). A process with `processes.current_epoch = 0` that ran 24.2h performed essentially no epoch work — it stalled before or between epochs, accumulating wall-clock time with no forward progress recorded in `epoch_results`.

- **WHY-3:** The loop watchdog (documented in `utils/loop/CLAUDE.md`) emits a `PROCESS_STALE` event after 15 minutes of silence but is not documented as terminating the stuck process. Without a hard wall-clock kill, the process continues to exist in a stalled state, accumulating elapsed time in `processes.started_at` through `processes.completed_at`, until an external mechanism resolves the row near the 24-hour mark.

- **ROOT:** There is no enforced maximum process wall-clock duration in the system. The loop relies on organic completion (COMPLETE signal in progress.md detected at `utils/loop/orchestrator.sh:119`) or epoch exhaustion (max epochs reached at `utils/loop/orchestrator.sh:210`), but neither mechanism triggers when a process stalls outside the epoch loop entirely. This is confirmed by the `epoch_results` table: the three Apr 11 stuck processes show only 0–4 epoch records (`epoch_results.epoch_number` reaches at most 4), meaning 20+ hours elapsed outside any tracked epoch — duration that has no corresponding `epoch_results` row and therefore was never subject to epoch-level termination logic. When a process enters a stuck state — deadlock, stalled agent, unhandled error between epochs — it runs indefinitely until an external timeout resolves `processes.completed_at`.

- **CONFIDENCE:** HIGH

- **CONFIDENCE REASON:** Three independent processes on the same day produced near-identical ~24.2h durations despite different epoch counts. The probability of this occurring by coincidence from organic runtime variation is negligible. The absence of a documented hard process wall-clock limit in `utils/loop/CLAUDE.md` and `utils/loop/orchestrator.sh` corroborates the mechanism. The pattern is reproducible: all other days in the dataset with normal completion show per-process durations proportional to goal complexity, not uniform 24h values.

---

## 5. Categories Checked

| Category | Status | Finding |
|----------|--------|---------|
| Computation source errors | Checked | The metric uses `EXTRACT(EPOCH FROM (completed_at - started_at))/3600` which is arithmetically correct. The Apr 11 spike (72.72h) reflects genuine DB-recorded timestamps, not a computation artifact. No arithmetic error identified. |
| Input data quality | Checked | `processes.started_at` and `processes.completed_at` are set by the run harness and loop infrastructure. The ~24.2h values on Apr 11 appear in three independent process rows with corroborating epoch_results records, confirming real timestamps rather than data entry errors. |
| Exclusion/filtering logic | Checked | The `name NOT LIKE 'cron-%'` filter correctly excludes cron processes. The `status='completed'` and `completed_at IS NOT NULL` guards are appropriate. No evidence of misclassified or incorrectly filtered processes across the 8-day dataset. |
| Dispatch/infrastructure failures | Checked | The Apr 11 three stuck processes represent an infrastructure failure mode — processes that entered a stalled state, consumed wall-clock time without epoch progress, and eventually resolved to `status='completed'`. The missing hard process wall-clock timeout is the root infrastructure gap. |
| Prompt/goal specification | Checked | Goal quality affects epoch count and per-epoch duration, but the Apr 11 processes had `processes.current_epoch` values of 0, 3, and 4 — well below the configured maximum of 10 (`resources.config->>'epochs' on <uuid>`). Vague goals are not the cause of 24h durations. |
| External dependencies | Checked | Rate-limit handling exists in `utils/run/executor.ts:12` and `utils/run/executor.ts:184`. Rate limits produce stochastic, bounded delays — not the uniform ~24.2h signature seen on Apr 11. No evidence of external dependency failures driving the metric spikes. |
| Reference constants/calibration values | Checked | The `epochs: 10` cap in `resources.config->>'epochs' on <uuid>` is a correct calibration value for normal operation. The `CURRENT_DATE - 1` window is correctly scoped to yesterday's activity. No reference constant errors identified. |
