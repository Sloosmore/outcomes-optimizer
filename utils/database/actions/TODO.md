# Resource Write-Time Validation (Palantir-style)

Resources must pass type-specific validation rules at write time, not at read time (when it's too late). `utils/database/actions/` will export `upsertResource()` which enforces these rules before any INSERT or UPDATE touches the `resources` table.

## Skill Resource (`type = 'skill'`)

| Field | Rule | Rationale |
|-------|------|-----------|
| `config.prompt` | Required, non-empty string | `validateSkillConfig` in `utils/dispatch/dispatch.ts` rejects without it — poller silently skips the skill |
| `config.epochs` | Required, integer >= 1 | Missing = poller takes legacy `claude -p` path = `config.content` never read |
| `config.worktree` | Required, boolean | Same — part of the full-contract dispatch path |
| `config.git` | Required, boolean | Same |
| `config.pr` | Required, boolean | Same |
| `config.content` | Required, string, length > 100 chars (minimum viable prompt threshold based on observed skill history), no filesystem path patterns (`/skills/`, `SKILL.md`, `workspace/`) | The actual skill instructions — must be self-contained, no filesystem references. Note: denylist approach may produce false positives for prompts that legitimately discuss these concepts; consider a regex for path-like patterns (`/\w+/`, `\.md$`) if false positive rate is high |
| `config.metric` | Optional string — if present, must match `^[a-z][a-z0-9_-]*$` pattern | Prevents typos that silently break Gate 1 idempotency. Pattern extended from `^[a-z_]+$` to allow digits and hyphens — verify against existing `metric_key` values in `metric_snapshots` before finalizing |
| `config.formula` | Optional string — **mutually exclusive with `config.metric`** | Having both causes double-enrichment (enrichWithMetrics + enrichFormulaResources) |
| `config.chart` | Required if skill should appear on dashboard: `{type: "area", height: number}` | Without it, `hasChartData()` returns false and frontend shows "No data yet" even with history |

### Cross-field constraints

- `config.formula` XOR `config.metric` — exactly one or neither; having both causes double-enrichment (`enrichWithMetrics` + `enrichFormulaResources`) and silent data corruption
- `config.content` must not contain filesystem path patterns (`/skills/`, `SKILL.md`, `workspace/`) — see denylist note above

## Cron Resource (`type = 'cron'`)

| Field | Rule | Rationale |
|-------|------|-----------|
| `config.schedule` | Required, valid 5-field cron expression | Poller parses this with `cron-parser` |
| `config.enabled` | Required, boolean | Poller checks this before evaluating the schedule |
| `config.depends_on` | Optional string array — each entry must match an existing `metric_key` in `metric_snapshots` | Gate 0: poller skips if any dependency is missing from last 24h |
| Must link to exactly 1 skill | `resource_links` row: `from_id = cron.id`, link type = parent/child | Poller joins `cron → skill` via `resource_links` |
| Linked skill must pass all skill rules | Transitive validation | Prevents orphaned crons that fire but can't dispatch |

## Implementation Plan

The validation lives in `utils/database/actions/upsert-resource.ts`:

1. Look up validation rules for the resource's `type` (from `resource_type_properties` table or hardcoded initially)
2. Validate every required field exists with the correct type
3. Check cross-field constraints (formula XOR metric)
4. Check link rules (cron must link to a valid skill)
5. Reject with a clear error message listing all violations — not just the first one

### Where this fits in the existing architecture

- `resource_type_properties` table (proposed in `docs/proposals/resource-type-rules-goal.md`) defines per-type field rules
- `link_type_rules` table (in flight on `feat/link-type-rules` branch) defines valid link pairings
- This action layer combines both: field validation + link validation at write time
- All agent-core CLI commands that write resources (`agent-core resource add`, `agent-core metrics record`) route through this layer

### What this would have caught today

- Missing `epochs`/`git`/`pr` on agent-efficiency and developer-leverage -> **rejected at insert time** (not discovered after 100+ duplicate cron fires)
- `config.formula` AND `config.metric` both set -> **rejected as mutually exclusive** (not discovered after frontend showed wrong data)
- `config.prompt` referencing `SKILL.md` -> **rejected by forbidden substring** (not discovered after poller silently ran stale instructions)
- Missing `config.chart` -> **warning: skill won't appear on dashboard** (not discovered after screenshot showed "No data yet")
