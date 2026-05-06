---
name: oversight
description: >
  Autonomous reviewer for blind validation of agent outputs. Runs adversarial
  critique against a plan or result using parallel subagents. Called during
  dispatch's interview phase and by the PR review workflow. Composable —
  any agent or workflow can invoke it for independent validation.
context: fork
agent: general-purpose
---

# Oversight Skill

External review agent that evaluates without implementing. Handles PRD generation, adversarial review, and blind output validation.

## Core Principle

**I don't build, I evaluate.** All functions are from an external reviewer perspective - impartial, blind to implementation details, focused on outcomes.

## Invocation

This section documents how external callers invoke oversight. If you are running *as* oversight, ignore this section entirely and proceed to the mode sections below.

| Mode | Args to pass | When to use |
|------|-------------|-------------|
| diagnose | `diagnose {goal}` | Every epoch bootstrap — causal position analysis |
| generate | `generate {goal}` | Preflight — create PRDs when none exist |
| adversarial | `adversarial {goal}` | When stuck_count >= 2, or every 5 epochs |
| validate | `validate --goal {path} --outputs {path}` | After each story — blind output validation |
| driver-discovery | `driver-discovery --metric <key> --output-type fix-goal\|hypothesis-table [--process-id <uuid>] [--worktree-path <path>]` | Trace any metric key to its highest-leverage driver → generate goal output |

---

## Mode 1: Generate (Setup Epoch)

When invoked with `generate {goal}`:

### Phase 1: Generate Candidate PRDs

Use the Task tool to spawn a sub-agent:

```
Task tool:
  prompt: "Read skills/oversight/references/generator.md, then generate 3 diverse PRDs for this goal: {goal}. Write to workspace/prd-001.json, prd-002.json, prd-003.json"
  subagent_type: general-purpose
```

### Phase 2: Validate Each PRD

For each PRD, spawn a validator:

```
Task tool:
  prompt: "Read skills/oversight/references/prd-validator.md, then validate workspace/prd-{id}.json. Return validation results."
  subagent_type: general-purpose
```

### Phase 3: Compare and Select

Spawn a comparator:

```
Task tool:
  prompt: "Read skills/oversight/references/comparator.md, then compare all PRDs in workspace/. Select the best and report which prd-{id} should be active."
  subagent_type: general-purpose
```

### Phase 4: Report Results

Return to the caller:
- Which PRD was selected (e.g., `prd-002`)
- Selection rationale
- List of all PRDs generated

The caller (SYSTEM.md leader) will initialize `state.json` with these results.

---

## Mode 2: Adversarial (When Stuck)

When invoked with `adversarial {goal}`:

### Phase 1: Understand What Failed

Read `workspace/state.json` to understand:
- Which story or validation failed?
- What was the specific error?
- What is the current `active_prd`?
- What is the `stuck_count`?

Read the active PRD (`workspace/prd-{active_prd}.json`) to understand the current approach.

### Phase 2: Determine Next PRD IDs

Find the highest existing PRD ID:
```
Run: ls workspace/prd-*.json | sort | tail -1
```
Extract the number and increment for new PRDs.

### Phase 3: Generate Informed Alternatives

Spawn a sub-agent with FULL failure context:

```
Task tool:
  prompt: "Read skills/oversight/references/adversarial.md.

           The goal is: {goal}

           Current approach ({active_prd}): {brief description}

           What failed: {failure description from state.json}

           Diagnose whether this is a FUNDAMENTAL limitation or a TUNING problem.
           Generate 2-3 PRD candidates as a spectrum (variations if tuning, alternatives if fundamental).
           Write to workspace/prd-{next-id}.json, etc."
  subagent_type: general-purpose
```

### Phase 4: Rank All PRDs

Spawn comparator with failure context:

```
Task tool:
  prompt: "Read skills/oversight/references/comparator.md.
           Compare ALL PRDs in workspace/ including the current active one.
           The key failure to address: {failure description}
           Score and rank. Recommend: ITERATE, CONTINUE, SELECT, or PIVOT."
  subagent_type: general-purpose
```

### Phase 5: Report Results

Return to the caller:
- Failure diagnosis: TUNING | PRD_GAP | ARCHITECTURAL
- Recommendation: ITERATE | CONTINUE | SELECT | PIVOT
- If ITERATE or SELECT: which PRD to switch to
- Rationale explaining why this response fits the failure pattern
- Ranking of all PRDs

---

## Mode 3: Validate (After Each Story)

When invoked with `validate --goal {goal_path} --outputs {outputs_path}`:

**CRITICAL: This is BLIND validation.** You receive only the goal and outputs. You have NO knowledge of:
- The PRD or implementation approach
- The code that produced the outputs
- Any justifications or explanations

Your job: Does the output achieve the goal? Yes or no, with evidence.

### Phase 1: Parse Arguments

Extract from args:
- `--goal`: Path to goal file (e.g., `workspace/goal.md`)
- `--outputs`: Path to outputs directory (e.g., `workspace/final/`)

### Phase 2: Triage

Assess whether a full audit is needed:

1. Run `git diff HEAD` to see this epoch's uncommitted changes (validation runs before commit, so HEAD compares against the working tree)
2. Read the most recent `validation.json` from `workspace/epochs/`
3. Classify change fundamentality:
   - **Low**: Parameter tweaks, prompt wording, config, cosmetic fixes
   - **High**: New strategy, changed data flow, new dependencies, architectural changes
4. Triage decision:
   - **CONFIRM** (low): Carry forward prior criteria results. Only re-validate criteria affected by the diff.
   - **FULL_AUDIT** (high, or no prior validation): Full blind validation.

### Phase 3: Spawn Blind Validator

```
Task tool:
  prompt: "Read skills/oversight/references/output-validator.md.
           Then read {goal_path} to understand the success criteria.
           Then inspect {outputs_path} for actual outputs.
           Validate whether outputs achieve the goal.
           You have NO context about how these outputs were produced.
           Return structured verdict."
  subagent_type: general-purpose
```

For **CONFIRM**: match each criterion from the prior validation against the diff — re-validate criteria whose related code/config changed, carry forward results for unaffected criteria.

### Phase 4: Persist Results

Write validation results to `workspace/epochs/{N}/validation.json` where N is the current epoch.

**Create the epoch folder if it doesn't exist.**

```json
{
  "epoch": N,
  "timestamp": "ISO-8601",
  "triage": {
    "decision": "CONFIRM | FULL_AUDIT",
    "fundamentality": "low | high",
    "reasoning": "One sentence explaining the assessment",
    "prior_epoch_referenced": M,
    "criteria_revalidated": ["list of criteria re-checked, if CONFIRM"]
  },
  "goal_path": "{goal_path}",
  "outputs_path": "{outputs_path}",
  "verdict": "PASS | FAIL",
  "criteria_results": [
    {
      "criterion": "Description from goal",
      "result": "PASS | FAIL",
      "evidence": "What was observed"
    }
  ],
  "blocking_issues": ["List of FAIL items"],
  "recommendations": ["Suggestions if FAIL"]
}
```

### Phase 5: Report Results

Return the validation results to the caller.

**If verdict is FAIL, the story FAILS.** The leader cannot override this.

---

## Mode 4: Diagnose (Every Epoch Bootstrap)

When invoked with `diagnose {goal}`:

Build a causal understanding of the current position by analyzing all available data in the workspace. This runs every epoch during bootstrap so the leader starts with a structured diagnosis before deciding what to do.

### Phase 1: Load Context

The `{goal}` argument gives you the optimization objective upfront. Then read:
- `workspace/state.json` — current epoch, active PRD, metric trajectory, stuck_count, dead_ends, learnings
- `workspace/goal.md` — full goal details, target metrics, success criteria
- `workspace/progress.md` — epoch history and approach log

### Phase 2: Spawn Causal Analyst

Use the Task tool to spawn a sub-agent with the goal context:

```
Task tool:
  prompt: "Read skills/oversight/references/diagnose.md.

           The goal is: {goal}

           Read workspace/state.json, workspace/goal.md, and workspace/progress.md.
           Inventory all available data — metrics, intermediate signals, external
           sources, workspace artifacts, git history.

           Two distinct analyses (do not mix them):

           1. TRACE BACKWARDS (pipeline, funnel, or flow): Start from the
              outcome metrics and work backwards through however the strategy
              converts to results. How was this result actually derived?
              Identify the bottleneck stage.

           2. COMPARE ACTUAL VS PLAN: Read the active PRD. Where did reality
              match the plan? Where did it diverge? Categorize each divergence
              as planning_gap, execution_gap, external_factor, or positive_surprise.

           Write results to workspace/epochs/{N}/diagnosis.json where N is
           the current epoch from state.json."
  subagent_type: general-purpose
```

### Phase 3: Report Results

Return to the caller:
- **Position summary**: trajectory phase, key metrics vs targets, causal explanation
- **Data gaps**: what data was missing that would improve the diagnosis
- **Key insight**: the single most important thing for routing the next action

---

## Output Structure

After running this skill, workspace/ should contain:

```
workspace/
├── prd-001.json         # PRD candidates
├── prd-002.json
├── ...                  # More PRDs from adversarial reviews
└── epochs/
    └── {N}/             # All artifacts for epoch N
        ├── diagnosis.json
        ├── validation.json
        ├── adversarial-review.json
        └── comparison.json
```

## References

The `references/` folder contains prompts for each sub-task:

| Reference | Purpose | When Used |
|-----------|---------|-----------|
| `generator.md` | PRD generation rules | Generate mode, Phase 1 |
| `prd-validator.md` | PRD semantic validation | Generate mode, Phase 2 |
| `comparator.md` | Scoring and ranking | Generate & Adversarial modes |
| `adversarial.md` | Informed PRD generation with failure context | Adversarial mode, Phase 2 |
| `output-validator.md` | Blind output validation | Validate mode |
| `diagnose.md` | Causal position analysis | Diagnose mode, Phase 2 |
| `driver-discovery.md` | Metric-agnostic driver tracing algorithm | Driver-discovery mode |

Each reference is a detailed prompt that sub-agents read and follow.

## When This Skill is Used

The optimization cycle (SYSTEM.md) invokes this skill:

1. **Every epoch (Part 1)**: `diagnose` mode - causal position analysis before any action
2. **Preflight (Part 0)**: `generate` mode - create PRDs when none exist
3. **After each story**: `validate` mode - blind output validation (MANDATORY)
4. **When stuck_count >= 2**: `adversarial` mode - root cause analysis and informed PRD review
5. **Every 5 epochs**: `adversarial` mode - periodic sanity check
6. **On PIVOT**: `adversarial` mode - generate new PRD candidates (preserve all prior PRDs)
7. **When a metric cron needs driver analysis**: `driver-discovery` mode — trace metric to highest-leverage driver and generate goal output

## Verification

**What to check:** The `validate` mode must return FAIL on a known-bad output (one that omits required success criteria) and PASS on a known-good output (one with concrete, evidence-backed criteria). The discriminating signal is the verdict field in the JSON output — not just the exit code.

**How to run:**

Prepare a minimal goal file and two output directories:

```bash
# known-good: output directory contains captured execution evidence
# known-bad: output directory contains only code files (no execution output)

# Invoke validate on known-bad:
claude -p "validate --goal /path/to/goal.md --outputs /path/to/bad-outputs/" \
  --skill skills/oversight/SKILL.md
# The JSON response must contain: "verdict": "FAIL"
# And blocking_issues must be non-empty

# Invoke validate on known-good:
claude -p "validate --goal /path/to/goal.md --outputs /path/to/good-outputs/" \
  --skill skills/oversight/SKILL.md
# The JSON response must contain: "verdict": "PASS"
# And criteria_results must show all criteria as "result": "PASS"
```

**What failure mode it catches:** An oversight agent that passes its own output (self-certification) would fail to discriminate between a directory of source code files (no execution) and a directory of real terminal logs (execution confirmed). The `output-validator.md` doctrine explicitly requires the validator to re-run checks itself rather than trusting files the implementing agent wrote. A validator that reads `verification-results.json` and calls it PASS would pass a known-bad output. The FAIL verdict on the known-bad directory is the non-gameable signal.

**Why it cannot be gamed:** The known-bad output directory contains only source code — no command output, no query results, no captured exit codes. The `output-validator.md` execution gate requires the validator to detect this and return FAIL before evaluating any individual criterion. A validator that ignores the execution gate cannot produce the correct FAIL verdict on the known-bad input, so the test catches any regression in the execution-gate logic.
# sync-test: 2dd6107a28a6f77f05a69c1c318a078b27cc76e5
