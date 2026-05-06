---
name: simulations
description: Adversarial-loop simulation prompt — predicts how the optimization agent will interpret a goal before it is finalized.
---

# Simulation Reference

## Purpose

A simulation agent reads a draft GOAL.md and predicts what the optimization loop will actually build — not what the human intended, but what the agent will interpret from the text. The goal is to surface goal interpretation gaps *before* the expensive loop runs.

This is different from adversarial critique (which finds external blockers). Simulation finds **internal misalignment**: cases where the goal is technically accomplishable but the agent will do something subtly wrong while still passing all stated acceptance criteria.

---

## Simulation Agent Prompt

Give each simulation agent the full draft GOAL.md and this prompt:

```
You are simulating the optimization loop agent. You will receive a GOAL.md.
Your job is NOT to complete the goal. Your job is to predict, in detail, what
the optimization agent will actually do when it reads this goal.

Produce:

1. **Predicted work breakdown** — write the 3-5 units of work the agent will plan (the agent may call these stories, tasks, or phases). For each, write the acceptance criteria the agent will choose for itself. Be specific — what bash commands, what grep patterns, what test names? Note: the goal should have at most 7 success criteria total — if your prediction would require more, flag this as a scope-split signal.

2. **Predicted shortcuts** — for each story, identify the minimum action that
   passes the story's own acceptance criteria without actually achieving the
   real goal. Where will the agent declare "passed" while the human would say "not yet"?

3. **Interpretation divergences** — where does the goal text support a reading
   that differs from what the human most likely intended? List each ambiguity
   and which interpretation the agent will probably choose (usually the simpler one).

4. **Scope creep risks** — what will the agent add that wasn't asked for? Where
   will it build infrastructure "for future use" instead of solving the current problem?

5. **Missing deletion/integration criteria** — will the agent add new code
   alongside old code and call it done? Will it write unit tests for a module
   but never wire the module into the actual caller? Be explicit.

Be concrete and critical. This is not a success story — find the gaps.
```

---

## How to run simulations

After the adversarial critique and before finalizing GOAL.md, run at least 3 simulation agents in parallel:

```
Agent 1: "play the role of a conservative optimizer — takes the minimal interpretation of each story"
Agent 2: "play the role of an ambitious optimizer — over-engineers and adds unrequested infrastructure"
Agent 3: "play the role of a literal interpreter — follows the letter of every criterion and ignores the spirit"
```

Bring back their predicted stories and shortcuts. Compare them against what the human actually wants. Add the most dangerous divergences as explicit constraints in GOAL.md under a `## Constraints` section. If any divergence is ambiguous enough that only the user can resolve it, surface it during the presentation step (Step 3) — do not interrupt the adversarial loop to ask.

---

## Known failure patterns (from past runs)

Use these to calibrate simulation output. When a simulation agent's prediction matches one of these, flag it explicitly.

### 1. Extraction without deletion
**Pattern**: Goal asks to extract shared logic into a module. Agent creates the new module with unit tests, considers story done. The old inline code in the original caller is never removed or updated. Duplication persists.
**Signal**: Story acceptance criterion is "module file exists and tests pass" with no criterion for "old caller updated."
**Fix**: Add explicit criterion: "The original caller (name the file) no longer contains the duplicated logic. Grep confirms absence."

### 2. Implementation over-specification becomes literal
**Pattern**: Goal names a specific algorithm or pattern ("create a DAG", "use a factory pattern"). Agent implements exactly that, even if a simpler solution would better serve the actual need.
**Signal**: The goal uses implementation nouns instead of outcome verbs.
**Fix**: Rewrite to outcomes. "Dependencies resolve correctly" instead of "create a DAG." The agent will find the right tool.

### 3. Infrastructure prerequisite as soft gate
**Pattern**: A prerequisite provisions real infrastructure (DB branch, deployed service). It partially fails. Agent notes the failure, marks it satisfied anyway, and subsequent work runs against the wrong environment.
**Signal**: The prerequisites section involves deploying real infrastructure without a hard-failure criterion.
**Fix**: Make infrastructure provisioning a hard gate with a live verification that must succeed before other work can start. If it fails, the run stops.

### 4. Self-defined success criteria
**Pattern**: Agent writes its own PRD and stories. It defines acceptance criteria that are easier to pass than the human's real intent. All stories pass. Human is unsatisfied.
**Signal**: Goal success criteria are vague or missing. Agent fills the vacuum.
**Fix**: Pre-specify the highest-stakes acceptance criterion verbatim in GOAL.md. The agent must use it — it cannot write around an explicit criterion.

### 5. Unit tests without integration
**Pattern**: Agent extracts a utility, writes thorough unit tests with mocks, all pass. The utility is never called from production code. The real path is unchanged.
**Signal**: Story acceptance criterion involves `npm test` but no end-to-end path is specified.
**Fix**: Add a criterion: "The real entry point (name the file/function) calls the new utility. Grep confirms the import exists."

### 6. Unrequested framework
**Pattern**: Goal asks for two concrete things. Agent builds a general-purpose framework that could support N things in the future. The framework works but adds significant complexity for zero current benefit.
**Signal**: Agent 2 (ambitious optimizer) predicts this. Look for words like "registry", "plugin", "extensible", "future-proof" in the prediction.
**Fix**: Add explicit constraint: "Build for the two current cases only. No extensibility infrastructure."

### 7. Missing teardown
**Pattern**: Goal asks for infrastructure provisioners with create and teardown. Agent implements create (passes the test), teardown is a stub or missing. Tests mock it. Real teardown never verified.
**Signal**: Teardown is in the story but acceptance criteria only test create.
**Fix**: Add explicit criterion: teardown is called and the real system confirms the resource is gone.

---

## Goal quality checklist (run before exiting the adversarial loop)

For every goal, verify:

- [ ] **Outcome language, not implementation language** — does the goal say what to achieve, or how to achieve it? Rewrite any "create a X" to "accomplish Y using whatever approach fits."
- [ ] **Deletion criterion** — if the goal extracts or replaces something, is there an explicit "the old X is gone" criterion?
- [ ] **Integration criterion** — if the goal creates a new module/utility, is there an explicit "the real caller uses it" criterion?
- [ ] **Hard gates on prerequisites** — if the goal depends on provisioned infrastructure or credentials, does it hard-fail if provisioning fails?
- [ ] **No self-defined acceptance** — are the highest-stakes criteria written explicitly, so the agent can't soften them in its PRD?
- [ ] **Scope bounded** — is there an explicit "build only what's needed for the stated cases" constraint to prevent framework creep?

---

## When simulations are most valuable

Simulations surface the most issues for goals involving:
- Code extraction / refactoring (extraction-without-deletion risk)
- New shared modules (integration-without-use risk)
- Real infrastructure provisioning (soft-gate risk)
- Framework/registry patterns (scope creep risk)

For narrow, concrete goals (e.g. "fix this specific bug"), simulations may return nothing — but still run them. The quality checklist alone is never sufficient as an exit gate.
