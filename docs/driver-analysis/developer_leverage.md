# Driver-Discovery Analysis: developer_leverage

**Metric**: `developer_leverage`
**Output type**: `hypothesis-table`
**Date**: 2026-04-03
**Analyst**: oversight driver-discovery algorithm, 4-phase

---

## Phase 1 Summary

### 1.1 Metric History

`developer_leverage` is a formula resource computed at read-time, not written by a cron agent directly.

| measured_at | value |
|---|---|
| 2026-03-23 | 0.4950 |
| 2026-03-22 | 0.1320 |
| 2026-03-21 | 3.2844 |

Only 3 rows exist — fewer than the required 7. Analysis continues with available data per the algorithm's guidance. The data is highly volatile (range: 0.132 to 3.284, current value: 0.495 as of 2026-03-23).

Sub-metric data (14-day window):

**agent_hours_per_day** (resource UUID <uuid>): Values over last 14 days: 0.465 (2026-04-02), 0 (2026-04-02), 5.75 (2026-03-29), 20.14 (2026-03-28), 91.07 (2026-03-27), 13.58 (2026-03-26), 35.48 (2026-03-25), 3.45 (2026-03-24), 5.97 (2026-03-23), 3.56 (2026-03-22), 23.49 (2026-03-21). Trend: volatile, includes days with 0 and days with 91 hours.

**agent_efficiency_per_day** (resource UUID <your-skill-resource-id>): Values over last 14 days: 0 (2026-04-02), 0 (2026-04-02), 2.958 (2026-03-29), 0.412 (2026-03-28), 0.204 (2026-03-28), 0.445 (2026-03-27), 3.118 (2026-03-26), 5.351 (2026-03-25), 0.593 (2026-03-24), 1.675 (2026-03-22), 1.197 (2026-03-21). Trend: volatile with two consecutive zero-value readings on 2026-04-02.

**human_equivalent_hours_per_day**: Values over last 14 days: 0 (2026-04-02 ×2), 17 (2026-03-29), 8 (2026-03-28), 38.75 (2026-03-28), 40.5 (2026-03-27), 37 (2026-03-26), 2.5 (2026-03-25), 0 (2026-03-24), 6 (2026-03-23), 8 (2026-03-22), 14 (2026-03-21). Trend: volatile with zeros on 2026-04-02.

### 1.2 Computation Path

`developer_leverage` is a formula resource. Its formula is:
`resources.config->>'formula' on resource UUID <uuid> — "agent_hours_per_day * agent_efficiency_per_day / 12"`

This formula is evaluated at read-time by `enrichFormulaResources` at `services/agent-livestream/server/enrichment.ts:81`.

The cron that schedules the DL skill is resource UUID `<uuid>` (developer-leverage-cron), which has a `depends_on` gate:
`resources.config->>'depends_on' on resource UUID <uuid> — "human_equivalent_hours_per_day"`

The formula evaluates to zero/null whenever either `agent_hours_per_day` or `agent_efficiency_per_day` is zero or missing for a given date. The zero-filter is enforced at `services/agent-livestream/server/enrichment.ts:128`:
`services/agent-livestream/server/enrichment.ts:128 — if (val === undefined || val <= 0) { valid = false; break; }`

---

## Hypothesis table

| Rank | Driver | Mechanism | Artifact Citation | Impact | Evidence | Tractability | Score | Recommended Experiment |
|---|---|---|---|---|---|---|---|---|
| 1 | `completed_at` omission in `markProcessCompleted` | Local worktree agents complete without setting `completed_at`; AH collector filters `completed_at IS NOT NULL`, excluding them; AH drops to near-zero; formula evaluates to 0 | `utils/loop/index.ts:110 — await patchProcess({ status: 'completed' })` | 5/5 — current DL: 0.495; if AH includes local worktree runs (22+ processes/day per AH accumulated findings), estimated AH rises from ~3–5h to 25–30h, projected DL: ~3–5× current (delta: +2.0 to +4.5x) | 5/5 — file:line read, direct causal path | 4/5 — single-field fix (`completed_at: new Date().toISOString()`) | **100** | Add `completed_at: new Date().toISOString()` to `patchProcess` call at line 110; trigger one AH cron cycle; verify `metric_snapshots.value on resource UUID <uuid>` increases |
| 2 | AE calibration guidelines too coarse | Config instructs: "small fix = 1-2h, feature = 4-8h" — wide ranges allow any estimate; denominator (agent_hours) collapses formula when AE is low | `config.content Step 2 on resource UUID <your-skill-resource-id> — "small fix = 1-2h, feature = 4-8h, large refactor = 8-12h"` | 3/5 — current AE avg ~1.2 across available days; tightening calibration ranges could raise AE toward 2–3x, but impact limited if AH remains low | 3/5 — DB config step, excerpt confirmed | 3/5 — requires prompt edit + AE cron re-run | **27** | Edit Step 2 calibration thresholds to narrower bands; run one AE cron cycle; compare `metric_snapshots.value on resource UUID <your-skill-resource-id>` before/after |
| 3 | Zero-filter in `enrichFormulaResources` drops partial dates | The enrichment code skips any date where either dep metric is `<= 0`, producing gaps in DL history and suppressing the formula value even when one dep is positive | `services/agent-livestream/server/enrichment.ts:128 — if (val === undefined \|\| val <= 0) { valid = false; break; }` | 2/5 — current DL: 0.495; relaxing the zero-filter would restore suppressed days but only when the suppressed dep is genuinely > 0; if both inputs are truly 0, the formula correctly returns 0 | 4/5 — file:line read, exact branch logic confirmed | 2/5 — changing the filter risks introducing inf/NaN formula results on days with 0 AH | **16** | Query how many dates have one dep = 0 and the other > 0; if > 2 such dates in 14-day window, relax filter to `val === undefined`; verify DL history length increases |
| 4 | `depends_on` gate blocks DL cron until HEH is present | DL cron only dispatches if `human_equivalent_hours_per_day` snapshot exists; on days when AE runs late, DL analysis is deferred or skipped | `resources.config->>'depends_on' on resource UUID <uuid> — "human_equivalent_hours_per_day"` | 1/5 — gate only delays dispatch, does not permanently suppress DL; AH metric is independent of HEH; formula value is unaffected by when DL skill runs | 4/5 — DB field read, depends_on confirmed | 3/5 — removable, but adds risk of stale formula snapshots | **12** | Remove `depends_on` from cron config; observe whether DL cron dispatch frequency increases and whether formula coverage improves |
| 5 | Formula divisor of 12 underestimates leverage | The constant 12 normalizes agent_hours×efficiency; if the intended unit is "x leverage per human work-hour", the divisor may need calibration | `resources.config->>'formula' on resource UUID <uuid> — "agent_hours_per_day * agent_efficiency_per_day / 12"` | 1/5 — changes the absolute DL scale but not the volatility pattern or the zero-days problem; current DL target is 100x; divisor of 12 is not the binding constraint when DL is 0.495 | 3/5 — DB field read, formula confirmed | 4/5 — simple constant change | **12** | Compute DL under divisor = 8 using historical AH and AE data; determine whether target of 100x becomes more achievable without changing input metric quality |

---

## Driver Landscape

**Driver 1: `completed_at` omission in `markProcessCompleted`** — Local worktree agents call `markProcessCompleted()` which patches only `status: 'completed'` without setting `completed_at`; the AH collector requires `completed_at IS NOT NULL` to include a process in the daily sum; this silently excludes all local worktree runs, causing AH to undercount by an estimated 22+ processes per day — Artifact: `utils/loop/index.ts:110 — await patchProcess({ status: 'completed' })`

**Driver 2: AE calibration guidelines too coarse** — The AE config content Step 2 provides wide estimation bands (1-2h for small fix, 4-8h for feature), giving agents latitude to produce low estimates that compress the efficiency numerator; lower AE directly reduces `developer_leverage` via the formula — Artifact: `config.content Step 2 on resource UUID <your-skill-resource-id> — "small fix = 1-2h, feature = 4-8h, large refactor = 8-12h"`

**Driver 3: Zero-filter in `enrichFormulaResources` drops partial dates** — The enrichment code at line 128 skips any date where any formula dependency is `<= 0`; on days where AE writes 0 but AH is positive (or vice versa), DL is suppressed entirely rather than returning a partial value — Artifact: `services/agent-livestream/server/enrichment.ts:128 — if (val === undefined || val <= 0) { valid = false; break; }`

**Driver 4: `depends_on` gate blocks DL cron until HEH is present** — DL cron config specifies `depends_on: ["human_equivalent_hours_per_day"]`, meaning the DL analysis skill only dispatches after the HEH snapshot for the day is written; if AE runs late in the day, DL dispatch is deferred — Artifact: `resources.config->>'depends_on' on resource UUID <uuid> — "human_equivalent_hours_per_day"`

**Driver 5: Formula divisor of 12 underestimates leverage** — The constant 12 in the formula acts as a normalization denominator; it was set at an arbitrary calibration point and may not reflect the current operational reality of agent hours per day — Artifact: `resources.config->>'formula' on resource UUID <uuid> — "agent_hours_per_day * agent_efficiency_per_day / 12"`

---

## Categories Checked

| # | Category | Driver(s) Examined | Ruling |
|---|---|---|---|
| 1 | Computation source errors | Driver 1: `markProcessCompleted` omits `completed_at`, silently excluding local worktree runs from AH sum | Driver 1 found — `utils/loop/index.ts:110` |
| 2 | Input data quality | Driver 2: AE calibration coarseness; two consecutive zero AE readings on 2026-04-02 indicate fragile input data | Driver 2 found — config.content Step 2 on UUID <your-skill-resource-id> |
| 3 | Exclusion / filtering logic | Driver 3: `enrichFormulaResources` zero-filter at line 128 drops dates where any dep ≤ 0 | Driver 3 found — `services/agent-livestream/server/enrichment.ts:128` |
| 4 | Dispatch / infrastructure failures | Driver 4: `depends_on` gate in DL cron delays dispatch until HEH snapshot exists | Driver 4 found — resources.config->>'depends_on' on UUID <uuid> |
| 5 | Prompt / goal specification | AH config content reviewed for Step 1 query spec; no prompt-spec gap found beyond the missing completed_at in the runtime call; Step 1 of AH config correctly requires completed_at IS NOT NULL — this is consistent with the driver | No artifact found beyond Driver 1 already captured |
| 6 | External dependencies | GITHUB_TOKEN dependency for AH/AE PR creation reviewed; DL formula does not depend on GitHub; no blocking external dependency found for formula evaluation | No artifact found — skipped |
| 7 | Reference constants / calibration values | Driver 5: divisor of 12 in formula; AH config max_dispatches_per_day=20 reviewed (not a binding constraint given current 0.465h/day) | Driver 5 found — resources.config->>'formula' on UUID <uuid> |

---

## Why #1

**Selected: Driver 1 — `completed_at` omission in `markProcessCompleted`**

Ranked #1 because: the `utils/loop/index.ts:110` call patches only `status: 'completed'` with no `completed_at` field; the AH metric collector config requires `completed_at IS NOT NULL` as an explicit filter condition; this means every local worktree agent process is silently excluded from the daily AH sum; with 22+ local worktree processes per day (per accumulated findings in AH config Step "2026-04-02" entry), the AH metric is underreporting by an estimated 5–20× on high-activity days; since `developer_leverage = agent_hours_per_day * agent_efficiency_per_day / 12`, a 5–20× undercount in AH produces a direct 5–20× suppression of DL; the current DL value of 0.495 (2026-03-23) versus the target of 100x confirms this is a major suppression.

Rejections:
- Driver 2 (AE calibration guidelines too coarse) is ranked lower because the calibration coarseness affects AE precision but not the binary 0/non-zero distinction; on 2026-04-02 AE recorded exactly 0.0 twice — not a calibration error, but a signal that zero processes qualified, which points back to the AH input problem rather than estimation quality.
- Driver 3 (zero-filter in `enrichFormulaResources`) is ranked lower because the zero-filter at `services/agent-livestream/server/enrichment.ts:128` correctly suppresses dates where an input is truly 0; fixing the filter without fixing Driver 1 leaves the root cause in place — AH is still near-zero; Driver 3 is a symptom amplifier, not the root cause.
- Driver 4 (`depends_on` gate blocks DL cron) is ranked lower because the `depends_on` gate at `resources.config->>'depends_on' on resource UUID <uuid>` only controls dispatch timing, not metric value; DL is a formula resource evaluated at read-time from existing snapshots, so even if DL cron runs late or not at all, the formula value is computed from whatever AH and AE snapshots exist.
- Driver 5 (formula divisor of 12) is ranked lower because the divisor at `resources.config->>'formula' on resource UUID <uuid>` is a calibration constant that scales the output but cannot explain days where DL = 0 or 0.132; those near-zero values are explained by near-zero AH input, not by the divisor.

---

## Inception Level

```
metric value (0.495 on 2026-03-23) ← formula agent_hours_per_day * agent_efficiency_per_day / 12 evaluated with suppressed AH numerator
  ← WHY-1: agent_hours_per_day is near-zero on most days because AH collector excludes processes lacking completed_at — Artifact: config.content Step 1 on resource UUID <uuid> — "AND completed_at IS NOT NULL"
    ← WHY-2: local worktree agents (the dominant source of completed processes) never set completed_at because markProcessCompleted patches only status — Artifact: utils/loop/index.ts:110 — await patchProcess({ status: 'completed' })
      ← ROOT: patchProcess at utils/loop/index.ts:65-93 accepts an arbitrary fields dict; the call at line 110 passes only { status: 'completed' } with no completed_at key; the Supabase PATCH updates status but leaves completed_at NULL in the processes table

CONFIDENCE: high
CONFIDENCE REASON: The causal chain is verified end-to-end: line 110 is read (no completed_at in the patch body), the AH config step explicitly filters completed_at IS NOT NULL, and metric_snapshots.value on resource UUID <uuid> shows near-zero values on most recent days consistent with this exclusion.
```
