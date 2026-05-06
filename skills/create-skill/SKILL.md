---
name: create-skill
description: >
  Conducts an interview, generates a verifiable GOAL.md through an adversarial
  review loop, and presents it for approval. Output: workspace/goal-<slug>.md
  (slug derived from goal title) with success criteria, metrics, and verification
  methods. Does not dispatch — hand off to the dispatch skill for that.
agent: general-purpose
context: fork
allowed-tools: Bash(*)
---

# Create Skill

> **Mode argument (required when called by another agent or CI)**: The caller must pass one of:
> - `--mode=interactive` — runs the full interview + confirmatory checkpoint. Default when a human is present.
> - `--mode=non-interactive` — skips ALL interview questions, approval steps, and confirmations. Writes the goal file immediately. Used for benchmarking, automated pipelines, and agent-to-agent calls.
>
> **When `--mode=non-interactive`**: Write the goal file to `workspace/goal-<slug>.md` and respond with ONE LINE only:
> ```
> FLOWS REQUIRING E2E VERIFICATION: [space-separated flow names, or "none"]
> ```
> No preamble. No file paths. No summaries. No markdown. The outer agent reads the goal file directly.
>
> **If no mode is specified**: assume `--mode=interactive`.

**90% verification fidelity means 10% entropy per cycle. Across 10 campaigns, that compounds to ~35% fidelity. Across 50, it's 0.5%.** Every goal you produce is a bet that the executing agent will build the right thing. The only thing standing between intent and entropy is the rigor of your success criteria and verification methods. Get them wrong, and the error compounds silently across every campaign that follows.

---

## Routing

**Automatic detection — no question needed**: Inspect the goal description before doing anything else.

If the description mentions ANY of the following, use **Feature Mode** immediately:
- Any `@skill-networks/*` or `@duoidal/*` package name
- Any path under `packages/`, `services/`, `skills/`, or `utils/`
- Any named package from the codebase (e.g. `agent-core`, `duoidal-cli`, `skill-networks-database`)

If none of the above match — the goal is unrelated to this codebase — use **General Mode**.

**Do not ask the user which mode to use.** Auto-detect from the description and proceed immediately.

---

## Feature Mode

### Step 1: Accept the Feature Description

The feature description is whatever the user provided as their prompt or request. Do not ask any questions. Treat the input as complete and proceed immediately to the parallel dispatch (Step 2).

**If invoked with a single-line goal description** (e.g., "refactor @skill-networks/database — split all files over 200 lines"), use that as the complete feature description. Do not ask follow-up questions.

### Step 2: Dispatch Six Parallel Groups

Dispatch Groups 1–5 simultaneously as background agents. **Group 6 must run inline** (direct Bash calls, not a background agent) — see Group 6 instructions below. Run Group 6 before waiting for Groups 1–5 results, or immediately after, but always in the main agent context.

**Group 1 — Regression Assembly**

Read `references/regression-assembly.md`. Crawl CLAUDE.md Verification sections in the impact zone derived from the feature description. For each folder, after reading its `## Verification` section, run `git log --all --oneline -- <folder>` and compare history against the current Verification section (Gap Detection Backstop — mandatory, see regression-assembly.md). Produce:
- Minimum regression floor (labeled "minimum, not complete") — the verifications that must still pass after this change
- Gap candidates — verifications that should exist but don't yet
- CLAUDE.md Gap Report — gaps found by comparing git history against current Verification sections

**Side-effect: CLAUDE.md gap PR (non-blocking).** If the Gap Report contains any entries, Group 1 opens a separate worktree, writes the CLAUDE.md amendments for each affected folder (adding the missing verification to the `## Verification` section), and opens a PR. This PR is independent of the main goal and does not block goal generation — the main goal continues regardless of whether the PR is opened or merged. The PR title must be: `fix(verification): backfill missing verification checks found by gap detection`.

**How gaps surface in the goal output.** The composer includes the Gap Report in the finalized goal document under a `## Detected CLAUDE.md Gaps` section, immediately after `## Constraints`. Each entry lists: folder path, what the gap is, and the git commit evidence. If no gaps were found, the section reads: `No CLAUDE.md gaps detected in the impact zone.`

**Group 2 — New Criteria Validation**

Read `references/new-criteria-validation.md`. Validate each proposed acceptance criterion against three checks: testability, environmental feasibility, and assumption cost.

For assumption cost: the following four load-bearing infrastructure items NEVER require assumption — they always require explicit user confirmation before any criterion that depends on them can be accepted:
- **auth** — authentication configuration, token storage, session handling
- **database schema** — table structure, column types, migration state
- **dispatch lifecycle** — how goals are submitted, queued, and resolved
- **process state machine** — valid state transitions and terminal states

Surface any criterion that assumes these without confirmation as a user confirmation question. Produce:
- Validated criteria set
- Dropped criteria with rationale
- Rewrite suggestions for failed criteria
- User confirmation questions for assumption cost items
- Prerequisite additions

**Group 3 — Implementation Perspective**

Read `references/implementation-perspective.md`. Trace the data flow for the described feature. Convert exit points into behavioral assertions. Produce:
- Behavioral assertion set (what the system must do, observable from outside)
- Criteria elevation flags (implementation-level criteria that must be rewritten as behavioral assertions)

**Group 4 — Adversarial Red Team**

Read `references/adversarial-red-team.md`. For each criterion in the assembled draft, generate a trivially compliant but wrong implementation that would satisfy the criterion while missing the actual intent. Produce:
- Challenge set with disposition recommendations (sharpen, split, drop, or keep as-is)
- Unchallenged criteria (explicit "no shortcut found" records)

**Group 5 — Non-Functional Historical**

Read `references/non-functional-historical.md`. Scan git history (default 90-day window) in the impact zone for failure patterns, performance regressions, and security incidents. Extract non-functional baselines from CLAUDE.md files and config. Produce:
- Non-regression criteria derived from historical failures
- Explicit non-functional targets (latency, error rate, cost, security constraints)
- Baseline gaps (where no historical baseline exists)

**Group 6 — Flow Enumeration**

**CRITICAL: Run Group 6 inline using direct Bash tool calls in the main agent context. Do NOT spawn a background subagent for Group 6 — background agents cannot access bash commands with the required permissions. Run these commands directly:**

Step 6a — Find all flows that directly traverse the blast radius node:
```bash
npx duoidal traverse --from <blast-radius-node> --via traverses --direction in --depth 1 --json
```
(Replace `<blast-radius-node>` with the correct resource node name, e.g. `package/skill-networks-database`.)

Step 6b — Additionally find consumers of the blast radius node and their flows:
```bash
npx duoidal traverse --from <blast-radius-node> --via dependsOn --direction in --depth 5 --json
```
For each consumer returned, run:
```bash
npx duoidal traverse --from <consumer> --via traverses --direction in --depth 1 --json
```
Merge all flow names from Steps 6a and 6b (deduplicated).

Step 6c — For each unique flow, get its observable steps:
```bash
npx duoidal show flow/<name> --json
```
Read the `config.steps` array from the JSON output.

Step 6d — For flows with empty `config.steps`, warn: "flow/X has no steps — author required before goal passes."

Step 6e — Emit: `FLOWS REQUIRING E2E VERIFICATION: [space-separated flow names with non-empty steps]`

Produce:
- Complete list of affected flows with their observable checkpoint steps
- Empty-steps warnings (flows in the graph with no steps authored)

### Step 3: Confirmatory Checkpoint

**Non-interactive mode** (`--mode=non-interactive`): **SKIP this entire step.** Do not surface any items for review. Do not ask any questions. Proceed immediately to Step 4: Finalize the Goal. All group outputs are accepted as-is.

**Interactive mode only** — After all six groups complete, surface five items for user review:

1. **Regression floor (labeled minimum)** — the assembled floor from Group 1, explicitly labeled "minimum, not complete." Ask: "Are there verifications missing from this floor that you know should be here?"

2. **New criteria** — the net-new behavioral assertions from Groups 3 and 5 that were not in the original description. Ask: "Do these capture what you intended?"

3. **Assumption cost** (findings) — the user confirmation questions raised by Group 2 for the four load-bearing infrastructure items (auth, database schema, dispatch lifecycle, process state machine). These must be answered before the goal is finalized. Ask each question explicitly.

4. **Adversarial challenges** — the challenge set from Group 4. For each criterion that received a "sharpen" or "split" disposition, present the shortcut scenario and the proposed fix. Ask: "Should any of these be resolved differently?"

5. **Flow completeness** — the `FLOWS REQUIRING E2E VERIFICATION` list from Group 6. For each flow, at least one success criterion must name at least one of that flow's observable checkpoints verbatim. Ask: "These flows are affected by this change. Are all their observable checkpoints covered in the success criteria?"

**Flow completeness gate**: A goal cannot proceed to finalization unless every flow in the FLOWS REQUIRING E2E VERIFICATION list has at least one success criterion naming at least one of that flow's observable checkpoints verbatim. If any flow's checkpoints are absent, the adversarial loop must flag them as gaps and the goal must be revised.

**Graph update gate**: If this goal introduces a new package, service, or user flow, the success criteria must include seeding those nodes with correct type, config, edges, and `valid_from` as a required acceptance criterion — not a recommendation. A goal that adds a new package or service without updating the graph is incomplete by definition.

Wait for the user to confirm or correct each surface before proceeding. (Interactive mode only — skip in non-interactive mode.)

### Step 4: Finalize the Goal

Incorporate all confirmatory checkpoint answers. Draft the final goal document.

**Modality requirement**: Every success criterion in the output goal MUST declare a modality tag indicating how it is verified. The allowed modalities are:

`browser | cli | database | artifact | http | deployment | comparison`

Append the tag in brackets to each criterion label, e.g. `**[cli] Criterion name**: ...`. A criterion without a modality tag is incomplete.

**Output format is mandatory and exact.** The section headings below must appear verbatim — `## Success Criteria`, `## Metrics`, `## Constraints`. Do not substitute synonyms. Automated systems parse these headings exactly.

Draft the goal internally (do not write to disk yet — the final version is written after user approval):

```markdown
# Goal: [brief title — max 8 words]

[1-2 sentence description]

## Architecture

[1-2 mermaid diagrams. Use `flowchart LR` for flows, `classDiagram` for interfaces, `sequenceDiagram` for multi-component interactions. 5-10 nodes. Graspable in 10 seconds.]

## Prerequisites

[Services, credentials, environment variables, or infrastructure that must exist before the loop starts. The dispatch skill provisions these — the loop agent assumes they are present. "None" if no external dependencies.]

## Affected Flows

FLOWS REQUIRING E2E VERIFICATION: [space-separated list of flow names from Group 6, e.g. flow/cli-login flow/dashboard-graph]

For each flow, list its observable checkpoints verbatim (from `config.steps`):

- **flow/[name]**: [step 1] → [step 2] → ... (include all steps that are E2E checkpoints)

[If no flows found: "No flows traverse the blast radius packages. No E2E flow coverage required."]

## Success Criteria

- **[modality] [Criterion]**: [verification method] → [what the real system confirms]
- **[modality] [Non-regression]**: [what existing behavior must still work]
- **[modality] [Consecutive-pass stability]**: Run the full test suite (or equivalent) N times in a row without any flap — must pass 3 consecutive clean runs to confirm non-flakiness.

## Metrics

[Scalar metrics table or "None — all criteria are pass/fail."]

## Constraints

[Constraints, or "None"]

## Post-Loop Action

[Left blank for the dispatch skill to fill in based on the chosen execution path.]
```

**`## Post-Loop Action` for Feature Mode goals must include the PR monitoring terminal phase.** When the dispatch skill fills this in, it must include the following terminal phase verbatim (adapted for the goal's slug and branch):

```markdown
### Terminal Phase: PR Monitoring Loop

After all success criteria pass and E2E flows are verified:

1. Open a pull request from the working branch to main: `gh pr create --title "..." --body "..."`
2. Wait for `pr-review.yml` to trigger and complete its review loop (up to 180 minutes).
3. For each CI check that fails (types, lint, build, vercel preview, pr-review): read the failure output, fix the issue, commit, and push. The PR review loop re-triggers automatically on push.
4. Repeat until ALL of the following are green:
   - `pr-review.yml` — score ≥ 8, zero CRITICAL/HIGH/MEDIUM issues
   - `vercel-build.yml` — preview URL returns 200 `/health`
   - Any type/lint/test checks defined in CI
5. Do NOT merge. Stop here and surface the PR URL to the user for final approval.
6. If a CI failure requires credentials, permissions, or external access you cannot obtain, call `npx duoidal process block --id "$EVAL_PROCESS_ID" --reason "<explanation>"` and exit. Do not fabricate fixes or mark the goal complete with failing CI.

The goal is not complete until the PR is open and all CI is green. Implementation done ≠ done.
```

**`## Affected Flows` is mandatory in Feature Mode goals.** It must be populated from Group 6 output. Each flow's observable checkpoints listed here must also appear verbatim in at least one success criterion (the flow completeness gate enforces this). Omitting this section or leaving it unpopulated causes the goal to fail the flow completeness gate.

**Non-interactive mode** (`--mode=non-interactive`): skip approval. Immediately derive a slug and write to `workspace/goal-<slug>.md`. Then respond with **ONLY this one line** (nothing else — no file path, no summary, no markdown):

```
FLOWS REQUIRING E2E VERIFICATION: [space-separated flow names from Group 6, or "none"]
```

This single line is machine-parsed by CI. Any text before or after it breaks the parser. The outer agent calling this skill will read the goal file separately to get the full content. Your job is to write the file and emit ONLY the FLOWS line as your response.

**When running interactively**: Present for approval. If the user approves, derive a slug and write to `workspace/goal-<slug>.md`. If an assignment was determined (via `--agent` flag or server config `default_link`), prepend the assignment frontmatter block before the `# Goal:` heading:

```markdown
---
assignment: [agent-or-user-name]
---
```

Then:

> "Goal written to workspace/goal-<slug>.md. Run the dispatch skill to send it somewhere:
> `/dispatch workspace/goal-<slug>.md`"

Done. Do not dispatch, launch, or execute anything.

---

## General Mode

### Refusal Gate

Before conducting the interview or drafting, apply this check:

**If the user's request lacks ALL THREE of the following, do NOT draft a goal. Instead, ask 1-3 targeted clarifying questions that, when answered, would unlock the draft.**

1. **Observable outcome** — Something that changes in a real system (a file, a database record, a network call, a UI state)
2. **System boundary** — The component, service, or interface that starts, stops, or receives input
3. **Success/failure distinction** — How the executing agent can tell it worked vs failed (without talking to a human)

**Examples of insufficient requests (refuse + ask):**
- "Build a logger utility" → Ask: What writes to this logger? Where are logs stored? What query confirms a log entry was written?
- "Add a create command" → Ask: Creates what type of resource? What file/service/record does it produce?
- "Make auth better" → Ask: What specific auth flow is broken? What metric defines "better"?

**Examples of sufficient requests (proceed to draft):**
- "Build a LiveKit voice agent that connects to LiveKit Cloud, answers calls, and responds using the Anthropic API" — observable (calls answered), system boundary (LiveKit Cloud + Anthropic API), success check (call completed + transcript)
- "Migrate from npm to pnpm in this monorepo" — observable (pnpm-lock.yaml created, node_modules managed by pnpm), system boundary (monorepo root), success check (CI passes)

When refusing: Ask exactly the missing questions. Do not apologize. Do not explain the framework. Just ask the clarifying questions.

---

### Step 1: Orientation

**Context is everything.** If invoked as a skill, the caller MUST pass comprehensive context — the agent starts fresh with zero prior knowledge. Current system state, research findings, design decisions, partial work, infrastructure details. Missing context cannot be recovered. Err on the side of too much.

If a context argument was passed, read it first. Extract everything: the goal, success criteria, constraints, design decisions. Treat extracted information as settled — do not re-ask.

### Conversation loop

Conduct the interview via voice if `mcp__voicemode__converse` is available. Fall back to text. Speak at speed 2. Write every question for the spoken word — short sentences, natural rhythm, never a bulleted list.

**What do you want to build or accomplish?**

Let them describe freely. Don't interrupt.

This is a loop — the user may not know exactly what they want. Go back and forth:

1. **Listen** — let the user describe the goal
2. **Research** — do a targeted research pass: read files, query schemas, check APIs, scan docs. Produce at least 3 specific findings (file paths read, schema fields discovered, API responses observed). If you already have strong domain familiarity, the pass can be brief — but it still happens. Never skip it entirely.
3. **Feedback** — reflect back what you heard, propose shape, ask targeted follow-ups
4. **Repeat** — keep looping until the user confirms they're happy with the direction

**Interview guidance:**
- If the user's description is abstract or framework-flavored, ask: "What is the first concrete thing this enables that you cannot do today?"
- If the user mentions more than 3 distinct outcomes, ask: "Which one matters most? Let's nail that one first."
- Only ask questions the research couldn't answer. Never ask a question you could answer from the codebase.

**Intent confirmation.** When the conversation converges, present a 3-bullet summary:

> "Before I draft, here's what I'm building toward: [1] [2] [3]. Is this right?"

If the user approves, continue to the agent/user assignment step below. If not, loop back. Do not draft until the user confirms intent.

**Agent/user assignment.** Every goal must be assigned to an agent or user that will run it. This determines where the goal appears on the dashboard. Query the available agents and users:

```bash
npx duoidal search "" --type agent --json
npx duoidal search "" --type user --json
```

Use your best judgment to match the goal to the right agent based on the goal's domain. If the match is not obvious, lightly ask:

> "Which agent or user should run this? Here are the active agents:
> [list agent names from the search output]"

Record the answer as the `RUNS_OWNER_NAME`. This is written as frontmatter at the top of the goal file so `duoidal execute` can resolve the assignment automatically:

```markdown
---
assignment: [agent-or-user-name]
---
```

This block goes before the `# Goal:` heading. Do not add a `## Assignment` section inside the body — frontmatter is the canonical location.

Now proceed to Step 2.

---

### Step 2: Adversarial Review Loop

#### Draft the goal

Before writing verification methods, read `references/validation-examples.md` and match each criterion to the closest example pattern. If no pattern fits, propose a new proof method: observable evidence in the real system.

For goals modifying code, infrastructure, schemas, or shared configuration, also read `references/blast-radius.md`. Apply the applicability gate: if any existing artifact depends on what's changing, trace the full dependency cone before drafting success criteria.

For all goals, also read `references/interaction-testing.md`. Apply the compiles ≠ behaves principle: structural checks alone (type correctness, lint, build success, schema validation) do not confirm the system behaves correctly. Every success criterion must verify at the appropriate level in the hierarchy (structural → integration → behavioral → E2E) — no criterion that can be satisfied by passing compilation counts as done.

Goals never contain implementation steps — only success criteria, metrics, and verification methods. The executing agent figures out the how. Interface contracts and verification commands are specification (allowed); step-by-step instructions are not.

**Output format is mandatory and exact.** The section headings below must appear verbatim — `## Success Criteria`, `## Metrics`, `## Constraints`. Do not substitute synonyms (`## Goals`, `## Acceptance Criteria`, `## Completion Criteria`, `## Requirements`). Automated systems parse these headings exactly. Variation silently breaks downstream tooling.

Draft the goal internally (do not write to disk yet — the final version is written after user approval in Step 3):

```markdown
# Goal: [brief title — max 8 words]

[1-2 sentence description]

## Architecture

[1-2 mermaid diagrams. Use `flowchart LR` for flows, `classDiagram` for interfaces, `sequenceDiagram` for multi-component interactions. 5-10 nodes. Graspable in 10 seconds.]

## Prerequisites

[Services, credentials, environment variables, or infrastructure that must exist before the loop starts. The dispatch skill provisions these — the loop agent assumes they are present. "None" if no external dependencies.]

## Success Criteria

- **[Criterion]**: [verification method] → [what the real system confirms]
- **[Criterion]**: [verification method] → [what the real system confirms]
- **[Negative test]**: [bad input or failure path] → [system rejects or fails correctly]
- **[Non-regression]**: [what existing behavior must still work]
- **[Consecutive-pass stability]**: Run the full test suite (or equivalent) N times in a row without any flap — must pass 3 consecutive clean runs (or "CI must be green for 3 successive runs") to confirm non-flakiness.

> **Consecutive-pass requirement is mandatory.** Every goal MUST include a stability criterion specifying minimum consecutive clean runs (e.g. "must pass 3 consecutive clean runs", "CI green for 3 successive runs without flaps", "zero failures across 5 sequential executions"). This prevents optimizing toward solutions that pass once but are flaky in practice.

## Metrics

For scalar goals:

| Field | Type | Direction | Target |
|-------|------|-----------|--------|
| ssim_score | number | maximize | 0.95 |
| ai_detection_score | number | minimize | 0.20 |

Maps to metricsSchema on the process record. For mixed goals, include scalar fields here and note which Success Criteria are boolean pass/fail.

For purely boolean goals: "None — all criteria are pass/fail."

## Constraints

[Constraints, or "None"]

## Post-Loop Action

[Left blank for the dispatch skill to fill in based on the chosen execution path. For feature goals, the dispatch skill must include the PR Monitoring Loop terminal phase — see Feature Mode Step 4.]
```

#### Run adversarial critique

Spin off at least 3 adversarial subagents in parallel using the Agent tool. Give each the full goal draft and research findings. Their job is to find reasons it will FAIL:

- Success criteria that are technically satisfiable but miss the user's actual intent
- Verification methods that can pass while the real system silently fails
- Missing prerequisites (credentials, services, environment variables)
- Missing non-regression checks — what existing behavior could this break?
- Criteria that are impossible to verify from within the loop
- Ambiguities the executing agent will interpret differently than the user intended
- Scope creep — criteria that don't serve the core goal

#### Run simulation

After the adversarial critique, run the simulation from `references/simulations.md`. At least 3 simulation agents predict how the loop agent will interpret the goal — what stories it will create, what shortcuts it will take, where its interpretation will diverge from intent. This is different from the adversarial critique: critique finds external blockers; simulation finds internal misalignment. More perspectives surface more divergences.

#### Run quality checklist

Before exiting the loop, run the Goal quality checklist from `references/simulations.md`. Every item must pass.

#### Fix and repeat

Incorporate all findings — adversarial, simulation, and checklist.

**Exit condition:** The loop exits when adversarial agents return zero actionable findings AND the simulation surfaces no interpretation divergences AND the checklist passes clean. If any adversarial agent returns zero findings, that agent's output is suspect — re-run it with the instruction: "The previous round found nothing. Look harder, or explicitly confirm each checklist item passes with a specific rationale."

Any findings dismissed as non-actionable must be explicitly listed with a one-sentence rationale. The next round's adversarial agents receive both the updated goal AND the dismissal rationale, and can challenge dismissals.

---

### Step 3: Present

**Non-interactive mode** (`--mode=non-interactive`): output the complete goal document directly as your response. Do not ask for approval. Do not add any preamble or conversational wrapper. The raw markdown is your entire response.

**When running interactively**: present for approval as described below. If the user is in a desktop environment, you may open markdown files in the system's default viewer (`open "<path>"` on macOS, `xdg-open "<path>"` on Linux). Otherwise, present file contents directly in the conversation.

Show the user:
1. The **mermaid diagram** — render via `mcp__mermaid__mermaid_preview` if available. If not, present the raw mermaid block and tell the user: "Paste this into mermaid.live to see the diagram."
2. The **success criteria** — including non-regression criteria
3. The **metrics** — scalar fields with direction and targets
4. The **constraints** — what the executing agent must not do
5. The **verification methods** for each criterion

> "Here's the goal. [Walk through the diagram.] The success criteria are [X]. Metrics: [Y]. Constraints: [Z]. Here's how each criterion gets verified. Does this match what you had in mind?"

If the user approves, derive a slug from the goal title: lowercase, replace non-alphanumeric runs with hyphens, collapse consecutive hyphens into one, truncate to 30 characters, trim leading/trailing hyphens. If the resulting slug is empty, ask the user for a more descriptive title. Examples: "Credential Vault Link" → `credential-vault-link`; "OAuth 2.0 (PKCE)" → `oauth-20-pkce`. Write the final version to `workspace/goal-<slug>.md`, with the assignment frontmatter block as the first three lines:

```markdown
---
assignment: [RUNS_OWNER_NAME]
---
# Goal: ...
```

> "Goal written to workspace/goal-<slug>.md. Run the dispatch skill to send it somewhere:
> `/dispatch workspace/goal-<slug>.md`"

Done. Do not dispatch, launch, or execute anything.

---

## Principles

- **Proof is the only thing that matters.** Observable evidence in the real system. If you can't point to something in the real world that changed or was confirmed, it's not done.
- **90% fidelity means 10% entropy per cycle, and that compounds.** Too many tests is not as bad as not enough tests. When in doubt, add the verification.
- **Non-regression is mandatory.** Every goal must ensure prior working things still work. New criteria add to the list, they never replace it.
- **Scope is a weapon.** A goal with more than 7 success criteria is probably two goals. Split before dispatching. The adversarial loop adds checks — you must also prune.

---

## Anti-Patterns

- **Never skip the adversarial loop.** Every goal goes through critique + simulation + checklist before presentation. This applies even when context is pre-supplied and no human interview is needed — the adversarial loop is not optional.
- **Never use synonym headings.** The output must use `## Success Criteria`, `## Metrics`, `## Constraints` exactly. Not `## Goals`, `## Acceptance Criteria`, `## Completion Criteria`, or any other variant.
- **Never skip the intent confirmation.** The 3-bullet summary before drafting catches misalignment early.
- **Never skip the research pass.** Minimum 3 specific findings. Never ask a question you could answer from the codebase.
- **Never present without the mermaid diagram.** Render it or provide the raw block with a mermaid.live link.
- **Never accept vague criteria.** Every criterion needs a verification method that touches the real system.
- **Never accept observation as proof.** "The script ran without errors," "file exists," "API returned 200" — these are observations. Proof is observable evidence of the downstream effect.
- **Never include implementation steps in the goal.** Success criteria and verification methods only.
- **Never dispatch or execute.** This skill writes goal-<slug>.md. Period.

## Verification

**What to check:** When invoked via `claude -p` in non-interactive mode, the skill produces a complete `workspace/goal-<slug>.md` file that contains all required sections with concrete, verifiable success criteria — not vague assertions.

**How to run** (uses the eval harness against the real skill via the fixtures pipeline):
```bash
cd skills/create-skill/evals
npx tsx run.ts --k 1 --workers 1
```

The eval runner invokes `claude -p` with each fixture's `input_spec`, captures the raw goal output, runs both tier-1 (structural) and tier-2 (LLM judge) checks, and writes a structured score report to stdout. A passing run must show:
- Tier 1: `success_criteria_present: true`, `metrics_present: true`, `constraints_present: true`
- Tier 2: all seven rubric dimensions (`pairing_coverage`, `e2e_full_chain`, `consecutive_pass`, `lazy_path_coverage`, `outcome_language`, `cone_coverage`, `behavioral_verification`) scoring ≥ 3

To verify without the full eval pipeline, run a single direct invocation:
```bash
echo "Migrate this monorepo from npm to pnpm" | claude -p --skill skills/create-skill/SKILL.md
# Pipe output to a temp file and check required headings:
# grep -c "^## Success Criteria" goal-output.md   → must be 1
# grep -c "^## Metrics" goal-output.md             → must be 1
# grep -c "^## Constraints" goal-output.md         → must be 1
# grep "pnpm-lock.yaml\|pnpm install" goal-output.md → must match (domain-specific proof, not generic "it works")
```

**What failure mode it catches:** A goal that uses vague criteria ("the migration is complete", "tests pass") would pass a header-presence check but fail the rubric judge on `pairing_coverage` and `behavioral_verification`. The LLM judge detects this; a simple structural grep cannot. The `consecutive_pass` dimension specifically catches goals that don't require multi-run stability — a common quality regression where the agent produces one-shot criteria instead of repeatable ones.

**Why it cannot be gamed:** The tier-2 LLM judge scores against a fixed rubric with numeric anchors and binarizes at ≥ 3. A generic or templated goal cannot score ≥ 3 on `cone_coverage` without naming actual downstream consumers of the changed system. The rubric's score anchors explicitly distinguish vague assertions (score 1–2) from domain-specific, mechanically verifiable criteria (score 4–5).
