# General Mode

> **Status: Draft — not yet active.** The inline `## General Mode` section in `SKILL.md` is the canonical specification agents follow. This file describes a proposed simplified restructure and must not be treated as authoritative until `SKILL.md` is updated to delegate to it.

Use this mode when the goal is unrelated to a specific package, service, or path in this codebase — the goal is about building something new, exploring a concept, or working in an external system.

---

## Refusal Gate

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

## Step 1: Orientation

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

Record the answer as the `RUNS_OWNER_NAME`. This gets passed to the dispatch skill for linking via `runs`.

Include the assignment in the goal metadata:

```markdown
## Assignment
Runs: [agent-or-user-name] — [why this agent/user is the right owner]
```

Now proceed to Step 2.

---

## Step 2: Adversarial Review Loop

### Draft the goal

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

Metrics are scalar values the **agent writes to the process record during execution** — not measurements taken after the process ends. Every metric must be computable from within the loop: a query the agent can run, a score the agent can calculate, a count the agent can observe. If a metric requires a human or an external system to evaluate it after the fact, it is not a metric — it is a post-hoc review and does not belong here.

For scalar goals:

| Field | Type | Direction | Target |
|-------|------|-----------|--------|
| ssim_score | number | maximize | 0.95 |
| ai_detection_score | number | minimize | 0.20 |

The `direction` field tells the loop whether higher or lower is better. The loop reads these from `metricsSchema` on the process record and tracks them across epochs — a trend across epochs is proof; a single snapshot is not. For mixed goals, include scalar fields here and note which Success Criteria are boolean pass/fail.

For purely boolean goals: "None — all criteria are pass/fail."

## Constraints

[Constraints, or "None"]

## Post-Loop Action

[Left blank for the dispatch skill to fill in based on the chosen execution path.]
```

### Run adversarial critique

Spin off at least 3 adversarial subagents in parallel using the Agent tool. Give each the full goal draft and research findings. Their job is to find reasons it will FAIL:

- Success criteria that are technically satisfiable but miss the user's actual intent
- Verification methods that can pass while the real system silently fails
- Missing prerequisites (credentials, services, environment variables)
- Missing non-regression checks — what existing behavior could this break?
- Criteria that are impossible to verify from within the loop
- Ambiguities the executing agent will interpret differently than the user intended
- Scope creep — criteria that don't serve the core goal

### Run simulation

After the adversarial critique, run the simulation from `references/simulations.md`. At least 3 simulation agents predict how the loop agent will interpret the goal — what stories it will create, what shortcuts it will take, where its interpretation will diverge from intent. This is different from the adversarial critique: critique finds external blockers; simulation finds internal misalignment. More perspectives surface more divergences.

### Run quality checklist

Before exiting the loop, run the Goal quality checklist from `references/simulations.md`. Every item must pass.

### Fix and repeat

Incorporate all findings — adversarial, simulation, and checklist.

**Exit condition:** The loop exits when adversarial agents return zero actionable findings AND the simulation surfaces no interpretation divergences AND the checklist passes clean. If any adversarial agent returns zero findings, that agent's output is suspect — re-run it with the instruction: "The previous round found nothing. Look harder, or explicitly confirm each checklist item passes with a specific rationale."

Any findings dismissed as non-actionable must be explicitly listed with a one-sentence rationale. The next round's adversarial agents receive both the updated goal AND the dismissal rationale, and can challenge dismissals.

---

## Step 3: Present

**When running interactively**: present for approval as described below. If the user is in a desktop environment, you may open markdown files in the system's default viewer (`open "<path>"` on macOS, `xdg-open "<path>"` on Linux). Otherwise, present file contents directly in the conversation.

Show the user:
1. The **mermaid diagram** — render via `mcp__mermaid__mermaid_preview` if available. If not, present the raw mermaid block and tell the user: "Paste this into mermaid.live to see the diagram."
2. The **success criteria** — including non-regression criteria
3. The **metrics** — scalar fields with direction and targets
4. The **constraints** — what the executing agent must not do
5. The **verification methods** for each criterion

> "Here's the goal. [Walk through the diagram.] The success criteria are [X]. Metrics: [Y]. Constraints: [Z]. Here's how each criterion gets verified. Does this match what you had in mind?"

If the user approves, derive a slug from the goal title: lowercase, replace non-alphanumeric runs with hyphens, collapse consecutive hyphens into one, truncate to 30 characters, trim leading/trailing hyphens. If the resulting slug is empty, ask the user for a more descriptive title. Examples: "Credential Vault Link" → `credential-vault-link`; "OAuth 2.0 (PKCE)" → `oauth-20-pkce`. Write the final version to `workspace/goal-<slug>.md`.

> "Goal written to workspace/goal-<slug>.md. Run the dispatch skill to send it somewhere:
> `/dispatch workspace/goal-<slug>.md`"

Done. Do not dispatch, launch, or execute anything.
