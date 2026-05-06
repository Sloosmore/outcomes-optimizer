# Feature Mode

> **Status: Draft — not yet active.** The inline `## Feature Mode` section in `SKILL.md` is the canonical specification agents follow. This file describes a proposed simplified restructure and must not be treated as authoritative until `SKILL.md` is updated to delegate to it.

Use this mode when the goal description mentions any `@skill-networks/*` or `@duoidal/*` package name, any path under `packages/`, `services/`, `skills/`, or `utils/`, or any named package from the codebase (e.g. `agent-core`, `duoidal-cli`, `skill-networks-database`).

---

## Step 1: Accept the Feature Description

The feature description is whatever the user provided. Do not ask questions. Treat the input as complete and proceed immediately to Step 2.

**If invoked with a single-line goal description**, use that as the complete feature description. Do not ask follow-up questions.

---

## Step 2: Dispatch Four Parallel Background Agents

Dispatch Groups 1–4 simultaneously as background agents and let them run. Do not wait for them — proceed immediately to Step 3 (Flow Enumeration) while they work.

**Group 1 — Regression Backstop**

Read `references/regression-assembly.md`. Crawl `## Verification` sections in CLAUDE.md files within the blast radius. For each folder, run `git log --all --oneline -- <folder>` and compare against the current Verification section. Produce:
- Minimum regression floor (labeled "minimum, not complete") — build, typecheck, test commands that must still pass after this change
- CLAUDE.md Gap Report — verifications implied by git history that are missing from current Verification sections

**Side-effect: CLAUDE.md gap PR (non-blocking).** If gaps are found, open a separate worktree PR with title `fix(verification): backfill missing verification checks found by gap detection`.

**Group 2 — Adversarial Red Team**

Read `references/adversarial-red-team.md`. For each criterion in the assembled draft, generate a trivially compliant but wrong implementation that would satisfy the criterion while missing actual intent. Produce:
- Challenge set with dispositions: sharpen, split, drop, or keep as-is
- Unchallenged criteria (explicit "no shortcut found" records)

**Group 3 — Historical Non-Functional**

Scan git history (90-day window) in the blast radius for failure patterns, performance regressions, and security incidents. Extract non-functional baselines from CLAUDE.md files. Produce:
- Non-regression criteria derived from historical failures
- Explicit non-functional targets (latency, error rate, cost, security constraints)

**Group 4 — Assumption Cost Gate**

Flag any criterion that assumes one of these four load-bearing items without explicit confirmation:
- **auth** — authentication configuration, token storage, session handling
- **database schema** — table structure, column types, migration state
- **dispatch lifecycle** — how goals are submitted, queued, and resolved
- **process state machine** — valid state transitions and terminal states

Produce: user confirmation questions for each assumption.

---

## Step 3: Flow Enumeration (run yourself — Bash tool calls only, no subagents)

**This step runs in your own context using the Bash tool. Do not delegate it to a subagent — run every command yourself. Complete this step fully before proceeding to Step 4.**

**This step is NOT subject to adversarial review.** Flow enumeration is mechanical — it reads the graph and formats the result. The adversarial loop operates on success criteria, not on live flow verification. Do not let adversarial findings remove or reduce the flow block.

This step produces the live flow criteria block that goes into `## Success Criteria`.

### 3a — Token check

```bash
npx duoidal health --json
```

The response is `{"ok": true, "checks": [..., {"name": "scope", "scope_size": N}]}`. Confirm `ok` is `true` and `scope_size > 10`. If not, stop and tell the user: "duoidal token is expired or wrong-scoped. Run `npx duoidal auth login` and retry."

### 3b — Identify every node in the impact zone

The `--from` argument must use DB resource names (e.g. `package/duoidal-auth`), NOT filesystem paths (e.g. `packages/auth`).

Search for every distinct concept in the feature description — both the **new thing being added** and the **existing system being extended**. If a goal adds "DaytonaProvisioner to the dispatch provisioner system", search for both "daytona" AND "dispatch" AND "provision".

For each keyword, run:
```bash
npx duoidal search "<keyword>" --json
```
Pick results whose `name` starts with `package/` or `service/`. If a search returns no `package/` result, try alternate related terms (e.g. "dispatch" → "utils", "provision" → "worktree"). Collect all confirmed DB names into your **node list**. A goal that modifies an existing package must include that package in the node list even if the package name doesn't appear literally in the goal description.

### 3c — Traverse around every node

For each node in the node list, run all five strategies yourself with the Bash tool:

```bash
# Strategy A — direct
npx duoidal traverse --from <node> --via traverses --direction in --depth 1 --json

# Strategy B — consumer chain
npx duoidal traverse --from <node> --via dependsOn --direction in --depth 5 --json
# then for each non-flow result: npx duoidal traverse --from <result> --via traverses --direction in --depth 1 --json

# Strategy C — parent/sibling
npx duoidal traverse --from <node> --via parent --direction out --depth 2 --json
# then: npx duoidal traverse --from <parent> --via traverses --direction in --depth 2 --json

# Strategy D — keyword search
npx duoidal search "<node-keywords>" --json
npx duoidal search "<feature-keywords>" --json

# Strategy E — reverse dependencies
npx duoidal traverse --from <node> --via dependsOn --direction out --depth 3 --json
# then for each dependency: npx duoidal traverse --from <dep> --via traverses --direction in --depth 1 --json
```

Collect every `flow/` name returned. Deduplicate across all strategies and all nodes.

### 3d — Fetch steps for each flow

For each unique `flow/` name:
```bash
npx duoidal show flow/<name> --json
```
Extract `config.steps`. If steps are empty, warn: "flow/X has no steps — author required before goal passes."

### 3e — Emit the live flow criteria block

Compose this block and hold it in memory — it gets pasted verbatim into `## Success Criteria` in Step 5.

**These criteria are mandatory and cannot be dropped.** Every flow returned by traversal must appear as a live criterion, regardless of whether the change seems to "directly" affect the flow. The purpose is non-regression: confirming the affected package still works end-to-end after the change. A structural refactor that leaves flows broken is a regression. Do not reason them away.

```
**Live flow verification (FLOWS REQUIRING E2E VERIFICATION: flow/name-1 flow/name-2 ...):**

> These are not unit tests, integration tests, or mocks. Each flow below is a live system path
> that must be verified by executing real tool calls against the running system. Do not simulate,
> stub, or infer — walk each step and confirm the observable outcome in the real system.

- **[modality] flow/name-1 — [terminal observable state]**: Walk: [step 1] → [step 2] → ... → confirm [what you see in the real system].
- **[modality] flow/name-2 — [terminal observable state]**: Walk: [step 1] → [step 2] → ... → confirm [what you see in the real system].
```

If traversal returns no flows: emit `FLOWS REQUIRING E2E VERIFICATION: none` and omit the block. This is the only valid reason to omit it — not because the flows seem unrelated.

---

## Step 4: Confirmatory Checkpoint

**Non-interactive mode** (`--mode=non-interactive`): Skip this step entirely and proceed directly to Step 5. Do not wait, do not ask questions, do not pause.

Wait for Groups 1–4 (from Step 2) to complete. Then surface four items for user review:

1. **Regression floor (labeled minimum)** — from Group 1. Ask: "Are there verifications missing from this floor that you know should be here?"
2. **Assumption cost** — confirmation questions from Group 4. Must be answered before finalizing. Ask each explicitly.
3. **Adversarial challenges** — from Group 2. For each "sharpen" or "split" disposition, present the shortcut and proposed fix.
4. **Flow completeness** — the live flow criteria block from Step 3. Ask: "Does each criterion accurately describe what to verify in the live system?"

**Flow completeness gate**: Every flow from Step 3 must have a live criterion with its observable steps verbatim. Absent criteria → revise before finalizing.

**Graph update gate**: If this goal introduces a new package, service, or user flow, the success criteria must include seeding those nodes (type, config, edges, `valid_from`) as a required criterion.

Wait for user confirmation before proceeding.

---

## Step 5: Finalize the Goal

Incorporate all checkpoint answers. Draft the final goal document.

**Design Principles extraction (mandatory):** Read the root `CLAUDE.md` and every `CLAUDE.md` in the blast-radius packages. Extract design principles (loose coupling, architectural boundaries, conventions). Populate the `## Design Principles` section of the goal with the base principles plus any package-specific principles found.

**Modality requirement**: Every success criterion MUST have a modality tag: `browser | cli | database | artifact | http | deployment | comparison`. Append in brackets, e.g. `**[cli] Criterion name**: ...`.

**Section headings are mandatory and exact**: `## Success Criteria`, `## Metrics`, `## Constraints`. Do not substitute synonyms.

```markdown
# Goal: [brief title — max 8 words]

[1-2 sentence description]

## Architecture

[1-2 mermaid diagrams. Use `flowchart LR` for flows, `classDiagram` for interfaces, `sequenceDiagram` for multi-component interactions. 5-10 nodes. Graspable in 10 seconds.]

## Prerequisites

[Services, credentials, environment variables, or infrastructure that must exist before the loop starts. "None" if no external dependencies.]

## Success Criteria

- **[modality] [Criterion]**: [verification method] → [what the real system confirms]
- **[modality] [Non-regression]**: [what existing behavior must still pass]
- **[modality] [Consecutive-pass stability]**: Must pass 3 consecutive clean runs to confirm non-flakiness.

[Paste the live flow criteria block from Step 3 verbatim here — do not rewrite or summarize it.]

## Metrics

[Scalar metrics the agent writes to the process record **during** execution — not post-hoc measurements. Each metric must be computable from within the loop. Format: `| field | type | direction | target |`. Or "None — all criteria are pass/fail."]

## Constraints

[Constraints, or "None"]

## Design Principles

[Read the root CLAUDE.md and every CLAUDE.md in the blast-radius packages. Extract all design principles — loose coupling, architectural boundaries, naming conventions, security constraints, testing requirements. Populate this section with every principle that applies to the new code being written. These are non-negotiable constraints, not suggestions.]

## Decomposition Strategy — Incremental Merges

**Do NOT build a single massive branch.** The goal of decomposition is to find the smallest unit of work that is independently verifiable end-to-end and mergeable. Ship it, merge it, rebase, and continue.

During implementation, decompose the work into sub-goals. Each sub-goal becomes its own PR. The agent determines the decomposition — it is not prescribed in the goal. The right decomposition emerges from understanding the dependency graph of the changes.

### The pattern

```
main
 └─ <working-branch>              ← your working branch
      ├─ sub/<first-module>        ← child branch for sub-goal 1
      │    → PR #N → CI green → merge to main
      ├─ sub/<second-module>       ← child branch for sub-goal 2 (rebased on updated main)
      │    → PR #N+1 → CI green → merge to main
      └─ ...
```

Each child branch:
1. Branches off your working branch (which tracks main)
2. Makes the changes for that sub-goal only
3. Runs the relevant proof commands to verify it works end-to-end
4. Opens a PR against `main`
5. Waits for CI to complete (use the process sleep mechanism if available, never bash sleep)
6. On wake: if CI is green, request merge. If CI fails, fix and re-push.
7. After merge: rebase your working branch onto updated main, then start the next child branch.

**Do not accumulate work.** A merged micro-PR is worth more than a passing criterion on an unmerged branch. Accumulating all changes on a single long-lived branch leads to stale diffs, merge conflicts, and PRs that are too large to review. Merge early, merge often.

### Opportunistic bug fixes

If you discover a bug while implementing — a wrong config key, a CI workflow that fails, a binary name that doesn't match — open a fix PR immediately. Do not accumulate fixes into the next feature PR. Each fix is its own PR, verified and merged independently.

The typical cadence for a multi-module goal looks like this:
1. **Foundation PR**: the first module — infrastructure, interfaces, or the lowest dependency
2. **Fix PRs**: bugs discovered after #1 merges and runs against the real system — each is its own small PR, merged immediately
3. **Next module PR**: the next feature built on the now-proven foundation
4. Repeat: discover, fix, merge, build the next thing

Each PR should be 5–100 lines when possible. The total work may be large but each increment is reviewable, independently verified against the real system, and merged before the next begins.

## Detected CLAUDE.md Gaps

[From Group 1 gap report, or "No CLAUDE.md gaps detected in the impact zone."]

## Post-Loop Action

[Left blank for the dispatch skill to fill in based on the chosen execution path.]

### Terminal Phase: PR Monitoring Loop

After all success criteria pass and E2E flows are verified:

1. Open a pull request: `gh pr create --title "..." --body "..."`
2. Wait for `pr-review.yml` to complete its review loop (up to 180 minutes).
3. For each CI check that fails (types, lint, build, vercel preview, pr-review): read the failure, fix, commit, push. The review loop re-triggers automatically.
4. Repeat until ALL green: `pr-review.yml` score ≥ 8, `vercel-build.yml` preview returns 200 `/health`, all type/lint checks pass.
5. Do NOT merge. Surface the PR URL to the user for final approval.
```

Derive a slug and write to `workspace/goal-<slug>.md`.

**Then immediately append the flow block from Step 3** — do not embed it in the draft above, append it to the file after writing. This ensures adversarial review cannot remove it:

```bash
cat >> workspace/goal-<slug>.md << 'EOF'

**Live flow verification (FLOWS REQUIRING E2E VERIFICATION: flow/name-1 flow/name-2 ...):**

> These are not unit tests, integration tests, or mocks. Each flow below is a live system path
> that must be verified by executing real tool calls against the running system. Do not simulate,
> stub, or infer — walk each step and confirm the observable outcome in the real system.

- **[modality] flow/name-1 — [terminal observable state]**: Walk: [step 1] → [step 2] → ... → confirm [what you see in the real system].
EOF
```

If Step 3 found no flows (`FLOWS REQUIRING E2E VERIFICATION: none`), skip the append.

Then present to the user:

> "Goal written to workspace/goal-<slug>.md. Run `/dispatch workspace/goal-<slug>.md` to send it."

Done. Do not dispatch, launch, or execute anything.
