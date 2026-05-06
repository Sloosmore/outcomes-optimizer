# Non-Functional + Historical Reference

## Role

Two agents that surface non-functional requirements by examining the system's history and its current operational baselines. These requirements are rarely stated in goal descriptions — teams assume them as given until something breaks. This role makes them explicit before the goal is dispatched.

Non-functional requirements discovered here become explicit constraints or success criteria in the goal. They are not optional if they represent real system baselines.

---

### Agent A: Git History Scan

Mines git history in the impact zone for evidence of past failures. The premise: the codebase has already told you what breaks in this area. Commit messages and PR titles that mention reverts, hotfixes, incidents, and regressions are a direct record of the failure patterns that past teams had to fix. This agent reads that record and surfaces the top failure patterns as required non-regression criteria.

**Search scope:** The impact zone — the same packages and folders identified as affected by the current change (from blast radius analysis). Agent A does not scan the entire repository. Failures outside the impact zone are not relevant to this goal's regression floor.

**What to look for in commit messages and PR titles:**

- `revert:` — something was reverted. What was reverted, and why? If the original change is similar to the current one, the revert reason is a required non-regression criterion.
- `hotfix:` or `fix:` on a short timeline after a feature merge — a feature introduced a regression that required immediate correction. What was the regression?
- Incident references — mentions of incident IDs, "incident", "outage", "down", "broken prod". What caused the incident in this area?
- `chore: rollback` or similar — deliberate undos that weren't labeled as reverts.

**How to run the scan:**

```bash
# Commits touching the impact zone in the last 90 days
git log --oneline --since="90 days ago" -- <impact-zone-paths>

# Commits with revert/hotfix/incident signals in the message
git log --oneline --grep="revert\|hotfix\|incident\|rollback\|broke\|regression" -- <impact-zone-paths>

# Who changed these paths most recently (for blame signal)
git log --oneline -20 -- <impact-zone-paths>
```

**Output:** A list of top failure patterns in the impact zone, ranked by recurrence. Each pattern becomes a candidate non-regression criterion. The criterion must describe what observable behavior must still hold — not the internal fix that was applied.

**Example:** If git history shows two reverts of changes to a rate limiter in `packages/example-package/`, the non-regression criterion is: "Requests exceeding the rate limit receive a 429 response within [threshold]ms — not a 500 or a silent pass-through." This is the behavioral guarantee that the reverts were protecting.

---

### Agent B: Non-Functional Baseline

Identifies the performance, security, and cost constraints that apply to the feature — not from git history, but from the current system's documented or observable baselines.

Agent B produces three categories of explicit targets:

**Performance targets** — latency, throughput, and reliability constraints that the feature must not degrade. These come from: SLA documentation (if present), CLAUDE.md Verification sections that reference timing assertions, existing test fixtures with timeout thresholds, and monitoring dashboards (if readable from the execution environment).

Examples of explicit performance targets:
- "p99 response time for the affected endpoint must remain under 500ms at current baseline load."
- "The feature must not increase cold start time for the worker process by more than 200ms."
- "Batch job must complete within the existing 5-minute timeout configured in `config/jobs.ts`."

**Security requirements** — access control, data isolation, and trust boundary constraints. These are especially important for changes that touch auth, data storage, or cross-process communication. Agent B checks: does the impact zone contain any RLS policies, credential handling, or trust boundary enforcement? If yes, what are the constraints?

Examples of explicit security requirements:
- "Queries against the `processes` table must respect the existing RLS policy — anonymous credentials must return zero rows."
- "The new endpoint must be behind the same auth middleware as adjacent endpoints — unauthorized requests must return 401, not 200 with empty data."
- "Credentials must not be logged, stored in plaintext, or passed via query parameters."

**Cost constraints** — API call budgets, storage write frequency, and compute cost limits. These are relevant for features that fan out to external APIs, write frequently to storage, or spawn new processes.

Examples of explicit cost constraints:
- "Each user action must result in at most one LLM API call — no unbounded fan-out."
- "The feature must not increase the daily Supabase storage write count by more than 10% at current usage levels."
- "Spawned subprocesses must terminate within 60 seconds — no orphan processes."

**How to derive baselines:**

1. Read `CLAUDE.md` Verification sections in the impact zone for documented timing or cost assertions.
2. Check `config/` for timeout, rate limit, and budget values already in the codebase.
3. Check `packages/` for existing test fixtures with threshold assertions.
4. Check monitoring configuration if available (dashboards, alert thresholds).

If no baseline exists for a category, Agent B states that explicitly — "No documented performance baseline found for this component" — rather than omitting the category. An absent baseline is itself a finding: it means the goal should either establish a baseline or add a note that performance was not evaluated.

---

### Merge Step

After both agents complete, merge their outputs into a single set of non-functional requirements:

- Agent A's failure patterns become explicit non-regression criteria in the goal.
- Agent B's performance, security, and cost targets become explicit constraints or success criteria.
- Requirements that overlap (e.g., Agent A found a past incident caused by a security bypass that Agent B independently identifies as a current constraint) are merged into one entry, noting both sources.
- Any gap (no documented baseline, no history) is listed explicitly — it is not silently dropped.

## Inputs

- **Impact zone** — the packages, folders, and files affected by the current change (from blast radius analysis). Both agents scope their search to this zone.
- **Git repository access** — Agent A requires `git log` access with the ability to filter by path and message content.
- **Codebase access** — Agent B requires read access to `config/`, `CLAUDE.md` files, and test fixtures within the impact zone.
- **Time window** (default: 90 days) — how far back Agent A scans git history. For stable, slow-moving packages, extend to 180 days. For actively developed packages, 90 days is usually sufficient.

## Outputs

- **Non-regression criteria** (from Agent A) — behavioral assertions derived from past failure patterns, ready to be added to the goal's Success Criteria.
- **Explicit non-functional targets** (from Agent B) — performance targets, security requirements, and cost constraints with specific thresholds.
- **Baseline gaps** — categories where no documented baseline exists, flagged explicitly.
- **Source attribution** — for every requirement, the evidence that supports it (commit hash, config value, CLAUDE.md path, or documented SLA).

## Failure Modes

**Git scan returns noise without signal.** Every commit in the impact zone is flagged because all contain `fix:` in conventional commit format. Fix: Agent A must apply semantic filtering — `fix:` on a typo or minor style issue is not a failure pattern. The signal is `revert:`, `hotfix:` on short timelines after a feature merge, or explicit incident language. A `fix:` alone requires additional context to be meaningful.

**Performance targets invented without evidence.** Agent B produces a latency target ("must be under 200ms") without citing a source — no SLA document, no existing test, no monitoring threshold. An invented target is worse than no target: it misdirects the executing agent. Fix: every target must cite its source. If no source exists, the target must be omitted and the gap must be flagged instead.

**Impact zone scoped too narrowly for Agent A.** A change touches a shared utility that has no git history because it was newly created — but the utility replaces an older one with significant failure history. Fix: if the impact zone contains newly created files that replace older ones, Agent A must also scan history for the predecessor paths.

**Security requirements treated as informational.** Agent B lists security constraints in a "notes" section rather than as explicit criteria or constraints in the goal. The executing agent may skip notes. Fix: security requirements from Agent B must appear as explicit constraints or negative-test criteria in the goal — not as commentary.

**Agent B omits cost constraints for high-fan-out features.** A feature that calls an external API per user event has obvious cost implications, but Agent B focuses only on performance and security. Fix: for any feature that touches external APIs, storage writes, or process spawning, Agent B must explicitly evaluate cost constraints — even if the current budget is unconstrained.
