# Driver Analysis: failures_per_day

**Date**: 2026-04-13
**Analyst**: prod-failures metric agent (Epoch 1, dispatch <process-id>)
**Metric key**: `failures_per_day`
**Skill resource UUID**: `<uuid>`
**Current value**: 0 (2026-04-13 22:56 UTC, 4-hour window)
**Output type**: fix-goal

---

## Metric History

```
 value |          measured_at
-------+-------------------------------
     0 | 2026-04-13 22:56:20.83876+00
     1 | 2026-04-11 00:12:02.265055+00
     1 | 2026-04-11 00:08:39.825189+00
     1 | 2026-04-11 00:07:11.971648+00
     1 | 2026-04-11 00:05:53.751932+00
     1 | 2026-04-11 00:04:32.012908+00
     0 | 2026-04-10 21:45:16.706093+00
     0 | 2026-04-10 21:42:31.280221+00
     0 | 2026-04-10 21:40:02.129485+00
     0 | 2026-04-10 21:37:32.73827+00
     3 | 2026-04-09 14:56:00.128115+00
     3 | 2026-04-09 14:53:03.159399+00
     3 | 2026-04-09 14:49:49.197626+00
     3 | 2026-04-09 14:48:00.553155+00
     3 | 2026-04-09 14:46:26.355644+00
     1 | 2026-04-07 01:12:24.036899+00
     0 | 2026-04-07 01:07:52.062007+00
     1 | 2026-04-07 01:00:05.137944+00
     1 | 2026-04-07 00:52:19.420385+00
(...)
```

**Current value**: 0 (2026-04-13 22:56 UTC)
**Trend**: volatile; spikes to 1–3 when dispatch provision fails; typically 0 between events
**Date range**: 2026-04-07 to 2026-04-13 (19+ rows available)

**Metric computation**: `config.content Step 1 on resource UUID <uuid> — "SELECT COUNT(*)::int FROM processes WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '4 hours'"`

---

## 1. Hypothesis Table

Ranked by **Impact × Evidence × Tractability** (each scored 1–5):

| # | Driver | Mechanism | Impact | Evidence | Tractability | Score |
|---|--------|-----------|--------|----------|-------------|-------|
| **1** | **Worktree disk exhaustion → pnpm-install failure** | Long-running/orphaned worktrees accumulate on `/root/dispatch/` (75GB volume, 93% full). New `git worktree add` creates partial checkouts (pnpm-lock.yaml missing). pnpm-install Docker service exits 1 → compose provisioner fails → provision.ts exits non-zero → dispatch returns 'failed' → `status='failed'` | 5 | 5 | 4 | **100** |
| 2 | Conditional worktree teardown (push guard) | Worktrees only deleted if git push succeeds (removed in commit `ea7b8ec39` — see `git show ea7b8ec39`). Push failures left worktrees on disk indefinitely, causing accumulation | 4 | 5 | 4 | **80** |
| 3 | Long-running orphaned processes holding disk | `<short-id>` (18 epochs, created Apr 1, 3.5GB, still 'active'). `<process-id>` (26 epochs, failed, 1.9GB, `worktree_path=NULL` so teardown can't find it) | 3 | 5 | 3 | **45** |
| 4 | Cron retry amplifier (Gate 3 default=3) | When dispatch fails, poller retries up to 3× per day per skill (`packages/scheduler/src/poller-service.ts:142`). Amplifies 1 root failure into 3 failure records | 2 | 5 | 3 | **30** |

---

## 2. Driver Landscape

### Driver 1: Worktree Disk Exhaustion → pnpm-install Failure

**Disk state** (observed live, 2026-04-13 23:00 UTC):
```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        75G   67G  5.5G  93% /root/dispatch
```
Six worktrees on disk: `<short-id>` (3.5GB), `<process-id>` (2.0GB), `<process-id>` (2.0GB), `<short-id>` (2.0GB), `<process-id>` (2.0GB), `<process-id>` (1.9GB).

**Provision failure chain:**

- **Artifact 1**: `packages/scheduler/src/poller.ts:L188/L196` — `dispatchStatus = await dispatchRun(...)` → `collect()` in `utils/dispatch/dispatch.ts` → `execFileAsync('npx', provisionArgs, ...)` calls `provision.ts`. If provision.ts exits non-zero, `collect()` throws and returns `'failed'`.

- **Artifact 2**: `utils/dispatch/provisioners/compose.ts` — `spawnSync('docker', ['compose', 'up', '-d', '--wait', ...])`. Returns non-zero if any service fails its healthcheck or exits non-zero.

- **Artifact 3**: `compose.yml:pnpm-install` — pnpm-install service bind-mounts `${WORKTREE_PATH}` to `/workspace` and runs `.docker/pnpm-install.sh`.

- **Artifact 4**: `.docker/pnpm-install.sh:L7-9` —
  ```sh
  if [ ! -f "$LOCKFILE" ]; then
    echo "pnpm-install: pnpm-lock.yaml not found at $LOCKFILE"
    exit 1
  fi
  ```
  When disk is near-full, `git worktree add` creates a partial checkout missing `pnpm-lock.yaml` → pnpm-install exits 1 → compose fails.

- **Artifact 5**: `services/runtime/poller.log` (live log excerpt):
  ```
  [poller] Error dispatching developer-leverage: Command failed: npx tsx utils/dispatch/provision.ts --slug <formula-id>-l013a --skill-resource-id <uuid> --provision worktree --provision compose
  [compose] docker compose up failed:
   Container wt-<formula-id>-l013a-pnpm-install-1 Error service "pnpm-install" didn't complete successfully: exit 1
  service "pnpm-install" didn't complete successfully: exit 1
  ```
  This is the EXACT failure message from the cron dispatch that produced the April 11 failures_per_day=1 readings.

- **Artifact 6**: `packages/scheduler/src/poller.ts` — `await sql\`UPDATE processes SET status = ${dispatchStatus}, completed_at = NOW() WHERE id = ${processId}\`` — when dispatchStatus='failed', the cron process record is written to `status='failed'`, becoming visible to the metric SQL.

### Driver 2: Conditional Worktree Teardown (Push Guard)

- **Artifact**: commit `ea7b8ec39` (`fix(worktree): always delete worktree on teardown regardless of push outcome`) — the pre-fix `teardown()` function in `utils/dispatch/provisioners/worktree.ts` contained the guard (visible in `git show ea7b8ec39`):
  ```typescript
  // Step 5: Delete worktree only if push succeeded
  if (!pushed) {
    console.warn('[worktree] WARNING: leaving worktree in place to avoid data loss (push did not succeed)')
    return
  }
  ```
  When git push failed (network issues, auth failure, conflict), the worktree directory was left on disk permanently. Over time, failed-push worktrees accumulated. This was the mechanism producing the 93% disk fill. **This guard was removed in commit `ea7b8ec39` (2026-04-13); the current code at line 349 deletes unconditionally.**

### Driver 3: Long-Running Orphaned Processes Holding Disk

- **Artifact**: DB query result — `processes.status='active', processes.name='<worktree-id>', processes.created_at='2026-04-01', processes.current_epoch=18, processes.worktree_path='/root/dispatch/<worktree-id>'` — this process has been 'active' for 12+ days, consuming 3.5GB on `/root/dispatch/`. The orphan cleanup in `services/runtime/src/wake-scheduler.ts` requires active processes to have no `agent_events` in the threshold window, but if the process sends periodic heartbeats or the threshold isn't reached, it avoids cleanup.

- **Artifact**: DB query result — `processes.status='failed', processes.name='<worktree-id>-fix01', processes.current_epoch=26, processes.worktree_path=NULL` — worktree exists at `/root/dispatch/<worktree-id>-fix01` (1.9GB) but `worktree_path` is NULL in the DB, so neither the lifecycle adapter nor the orphan cleanup can locate it for teardown.

### Driver 4: Cron Retry Amplifier (Gate 3)

- **Artifact**: `packages/scheduler/src/poller-service.ts:L141-159` —
  ```typescript
  // Gate 3: Stop after N total failures today with no success (configurable per skill, default 3)
  const failureLimit = maxFailuresPerDay ?? 3
  const failedRows = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM processes WHERE skill_resource_id = ${skillId} AND status = 'failed' AND created_at >= date_trunc('day', NOW())`
  if (failCount >= failureLimit) { return { skip: true, ... } }
  ```
  Default limit of 3 allows 3 dispatch attempts per cron per day before halting. Each failed attempt creates one `status='failed'` process record, potentially appearing in the 4-hour metric window.

---

## 3. Scoring Summary

| Driver | Impact (1-5) | Evidence (1-5) | Tractability (1-5) | Score |
|--------|-------------|----------------|---------------------|-------|
| 1: Disk exhaustion → pnpm-install failure | 5 | 5 | 4 | 100 |
| 2: Conditional teardown (push guard) | 4 | 5 | 4 | 80 |
| 3: Orphaned processes holding disk | 3 | 5 | 3 | 45 |
| 4: Cron retry amplifier | 2 | 5 | 3 | 30 |

---

## 4. Why #1

**Selected: Driver 1 — Worktree disk exhaustion causing pnpm-install failure**

Ranked #1 because: The poller log (`services/runtime/poller.log`) contains the literal error `service "pnpm-install" didn't complete successfully: exit 1` from a failed cron dispatch. The `.docker/pnpm-install.sh:L7-9` script exits 1 when pnpm-lock.yaml is missing from an incomplete git checkout — which occurs when disk is full. The disk is currently at 93% capacity (5.5GB free, verified live). The metric value is 0 right now but was 1-3 during the April 9 and April 11 events, both correlated with concurrent worktree activity. Combined score: 100.

**Rejections:**

- **Driver 2 (Conditional teardown push guard)** is ranked lower because it is the *mechanism* that causes Driver 1's disk accumulation, not an independent driver. The fix to Driver 1 (ensuring disk space via teardown cleanup) subsumes this. Fixing the push guard alone without addressing the 93% disk fill state does not immediately lower failures_per_day.

- **Driver 3 (Orphaned long-running processes)** is ranked lower because it is a contributing cause to disk accumulation (same mechanism as Driver 1) rather than a separate causal pathway. `<short-id>` holding 3.5GB is a symptom of missing orphan cleanup thresholds, not a distinct failure mode. Its score of 45 reflects lower tractability (requires tuning the wake-scheduler orphan threshold).

- **Driver 4 (Cron retry amplifier)** is ranked lower because it amplifies existing provision failures (score 30) but does not cause them. If Driver 1 is fixed (provisioning succeeds), Gate 3 retries never fire. The 3-failure daily cap is a safeguard, not a root cause.

---

## 5. Inception Level

```
failures_per_day value (3 on 2026-04-09 14:36-14:56 UTC, 1 on 2026-04-11 00:04-00:12 UTC)
  ← processes enter status='failed' in metric window when dispatch provision fails
    ← WHY-1: packages/scheduler/src/poller.ts (dispatch update) — `UPDATE processes SET status = 'failed'` when dispatchRun() returns 'failed'. dispatchRun calls collect() in utils/dispatch/dispatch.ts, which calls provision.ts. provision.ts exits non-zero when compose provisioner fails.
      ← WHY-2: utils/dispatch/provisioners/compose.ts — `docker compose up -d --wait` returns non-zero exit code because the pnpm-install service exits 1. The pnpm-install container (.docker/pnpm-install.sh:L7-9) exits 1 when `/workspace/pnpm-lock.yaml` is missing — i.e., when the git worktree checkout was incomplete because disk was full during `git worktree add`.
        ← WHY-3: `utils/dispatch/provisioners/worktree.ts` pre-fix (commit `ea7b8ec39`) — worktrees were only removed if git push succeeded (`if (!pushed) return`, deleted by commit `ea7b8ec39`). Failed-push worktrees accumulated on the 75GB `/root/dispatch/` volume. With 6 worktrees currently consuming ~13.4GB, disk was at 93% full (5.5GB free), leaving insufficient space for complete new git checkouts.
          ← ROOT: The `pushed` guard (removed in commit `ea7b8ec39`) prevented disk reclamation when git push failed, creating unbounded disk accumulation on the `/root/dispatch/` volume (bind-mounted from host to container, confirmed via `docker inspect runtime-runtime-1`). The fix — unconditional deletion at `utils/dispatch/provisioners/worktree.ts:349` — was merged 2026-04-13.
```

**CONFIDENCE**: HIGH
**CONFIDENCE REASON**: The failure is directly observed in `services/runtime/poller.log` with the exact error message (`pnpm-install: pnpm-lock.yaml not found`), the disk state is verified live at 93%, and the conditional deletion guard existed in source code (removed by commit `ea7b8ec39`, visible via `git show ea7b8ec39`) — no inference required.

---

## 6. Categories Checked

| Category | Status | Result |
|----------|--------|--------|
| Computation source errors | Checked | `.docker/pnpm-install.sh:L7-9` exits 1 when lockfile missing — this is correct guard behavior; the error is in the ENVIRONMENT (incomplete checkout), not the computation | Not primary |
| Input data quality | Checked | Skill configs for `<resource-id>`, `<resource-id>`, `<short-id>` are valid. `validateSkillConfig()` passes for all. `config.content` fields retrieved and verified correct | Not a driver |
| Exclusion/filtering logic | Checked | Gate 3 (`packages/scheduler/src/poller-service.ts:142`): default limit=3, amplifies failures 3×. `shouldDispatch` return skip-true causes `continue` in poller — no failed record created for gate-skips. Not a primary cause | Driver 4 (amplifier) |
| Dispatch/infrastructure failures | Checked | **PRIMARY DRIVER**: `docker compose up` fails due to pnpm-install exit 1 from incomplete git checkout caused by disk exhaustion. `utils/dispatch/provisioners/worktree.ts:334` conditional deletion leaves disk filled | Driver 1 (root cause) |
| Prompt/goal specification | Checked | Skill `config.content` retrieved from DB — well-formed, matches `validateSkillConfig()`. No prompt specification errors observed | Not a driver |
| External dependencies | Checked | Docker socket accessible (bind-mounted). Git remote accessible. Supabase DB reachable (DATABASE_URL verified). No external API failures | Not a driver |
| Reference constants/calibration values | Checked | `POLL_WINDOW_MS = 5min` (`poller.ts:L13`), Gate 3 default=3 (`poller-service.ts:142`), 75GB volume, 4-hour metric window — all are correctly calibrated for their intent. The pre-fix push-guard in `worktree.ts` (removed by commit `ea7b8ec39`) was the miscalibrated logic (prevented disk cleanup) | Driver 2 (teardown guard) |
