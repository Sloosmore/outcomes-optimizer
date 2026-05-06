# Adversarial Red Team

## Role

The Adversarial Red Team agent generates "trivially compliant but wrong" implementations for each acceptance criterion in the draft goal. Its purpose is to find criteria that an executing agent could satisfy — in the letter, not the spirit — while leaving the actual goal unachieved.

This is distinct from the adversarial critique in the main loop, which finds external blockers. The Red Team finds internal weaknesses in the criteria themselves: places where the text of a criterion is satisfiable without achieving the outcome the criterion was meant to guarantee.

The oversight skill (`skills/oversight/`) provides the quality bar this role enforces. Where oversight scores goal quality after the fact, the Red Team enforces it before the goal is finalized — generating adversarial implementations proactively rather than reviewing them retrospectively. The two complement each other: Red Team runs during goal drafting; oversight runs during campaign review.

---

### How It Works

One agent reads the complete draft criteria set — all success criteria, including non-regression and stability criteria — and for each criterion produces at least one "trivially compliant but wrong" implementation.

A trivially compliant but wrong implementation is one that:
- Satisfies the literal text of the criterion
- Would cause any automated check described in the criterion to pass
- Violates the intent of the criterion — leaves the actual goal unachieved or leaves the system in a broken state

The agent does not need to write real code. It describes the implementation in one or two sentences: what would the executing agent do, and why would the criterion's verification method not catch it?

---

### Per-Criterion Challenge Format

For each criterion, the agent produces a challenge record:

```
Criterion: [quote the criterion text verbatim]
Trivially compliant implementation: [one sentence describing the shortcut]
Why it passes: [what the verification method checks, and why the shortcut satisfies it]
Why it is wrong: [what the intent was, and what is broken]
Disposition: [required additional criterion | sharpen proof method]
```

**Example:**

```
Criterion: "Running `npx duoidal process list --status=completed` returns at least one process
           with `completed_at IS NOT NULL`"
Trivially compliant implementation: Directly UPDATE the processes table to set status='completed'
                                    and completed_at=NOW() for an existing process.
Why it passes: The CLI query will find a completed process. The check passes.
Why it is wrong: The goal requires the loop to complete a process via normal execution,
                 not via a direct database write. Direct writes bypass all loop logic.
Disposition: Sharpen proof method — add "and the process was dispatched by the loop within
             this run (verified by checking created_at matches the current run's start time
             and dispatch_id is not null)."
```

---

### Disposition Handling

Each challenge leads to one of two dispositions:

**Required additional criterion** — when the only fix is to add a new, independent criterion that catches what the current one misses. Use this when the shortcut exploits a genuine gap (an exit path that was never covered) rather than a weakness in the proof method.

**Sharpened proof method** — when the existing criterion is well-scoped but its verification method is too weak. The fix is to make the check non-fakeable: require the real system to participate in a way that a shortcut cannot mimic. See `references/multi-component-testing.md` Rule 4 (Lazy Path Detection) for the canonical pattern.

The Red Team agent does not make this decision alone. It proposes a disposition. The goal author reviews and either accepts the disposition or explains why the criterion is already adequately protected.

Any dismissed challenge must be recorded with a one-sentence rationale. The next round of adversarial agents receives the dismissal log and can challenge dismissed items — same protocol as the main adversarial loop in SKILL.md.

---

### Calibration: What Makes a Good Challenge

A good challenge is specific, concrete, and not obviously prevented by other criteria in the goal. It names an action an executing agent could plausibly take — not a hypothetical that no real agent would attempt.

**Strong challenge:** Names a specific shortcut (direct DB write, hardcoded fixture, mock injection) that satisfies the criterion's check while bypassing the real system.

**Weak challenge (do not emit):** "The agent could lie about the output." This is always technically true and adds no value. Challenges must describe a specific implementation path, not a generic deception.

**Strong challenge:** "The agent could write the expected output to the verification file before running the actual computation, satisfying the file-existence check without performing the computation."

**Weak challenge (do not emit):** "This criterion might not be tested enough." Vague insufficiency is not a challenge.

---

### Scope

The Red Team agent challenges all criteria in the goal, including:
- Functional success criteria
- Non-regression criteria ("existing behavior X still works")
- Stability criteria ("passes 3 consecutive runs")
- Negative test criteria ("bad input is rejected correctly")

Stability criteria are especially worth examining. A common trivially compliant implementation: run the test suite only once, confirm it passes, then write a loop that repeats the output three times without re-running. The criterion says "3 consecutive passes" — the shortcut reuses one result.

## Inputs

- **Complete draft criteria set** — all acceptance criteria from the GOAL.md draft, including non-regression, stability, and negative test criteria.
- **Goal context** — goal description and architecture, so the agent understands intent and can evaluate whether a proposed implementation violates it.
- **Previous dismissal log** (if iterating) — any challenges from prior rounds that were dismissed, with their rationale.

## Outputs

- **Challenge set** — one or more challenge records per criterion, in the format above.
- **Disposition recommendations** — for each challenge, a proposed fix (additional criterion or sharpened proof method).
- **Unchallenged criteria** — criteria for which no trivially compliant shortcut was found. The agent must state explicitly for each: "No compliant shortcut found because [reason]." Empty output on a criterion is not acceptable.

## Failure Modes

**Generic challenges that apply to every criterion.** The agent produces variations of "the agent could mock the system" without identifying the specific mock path for each criterion. These are not useful. Each challenge must be specific to the criterion it targets.

**Criteria left unchallenged without rationale.** The agent silently skips difficult criteria rather than attempting a challenge and explaining why no shortcut exists. This is indistinguishable from missing a shortcut. Fix: every criterion must have an explicit entry — either a challenge or a stated reason no shortcut was found.

**Shortcut is already prevented by another criterion.** The agent proposes a challenge that the combined criteria set already blocks. This wastes the goal author's review time. Fix: before emitting a challenge, check whether another criterion in the same goal would catch the proposed shortcut. If yes, note the interdependency and mark the challenge as resolved.

**Dispositions always recommend additional criteria.** When the proof method is weak, the right fix is often to sharpen the check — not to add a new criterion. A goal that accumulates additional criteria for every Red Team finding will quickly exceed the 7-criterion limit. Sharpening is usually cheaper. Default to sharpening unless a genuine gap exists.
