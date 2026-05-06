# Interaction Testing Reference

## The Compiles ≠ Behaves Principle

**Structural success does not imply behavioral correctness.**

> "Does this criterion confirm the system behaves correctly — or only that it is structurally sound?"

- If **structural only** → it cannot count as done. Elevate to the appropriate level.
- If **behavioral** → it can stand as a criterion.

Passing `tsc`, `eslint`, `cargo check`, `go vet`, schema validation, or a build pipeline confirms the artifact is structurally well-formed. It says nothing about what the system does at runtime. A codebase can compile cleanly while every user-facing feature is silently broken.

**This matters for goal drafting.** Every success criterion must be examined: what level of verification does it actually provide? Structural checks are necessary but never sufficient.

---

## Verification Hierarchy

Levels are ordered from weakest to strongest. Higher levels subsume the confidence of lower ones — but lower levels do not subsume higher ones.

| Level | What it confirms | What it misses |
|-------|-----------------|----------------|
| **Structural** | Type correctness, lint, build, schema validity, static analysis | Runtime behavior, integration handoffs, user-observable outcomes |
| **Integration** | Two real components exchange data correctly at a boundary | Full workflow, user-facing behavior, edge cases across the system |
| **Behavioral** | Observable system behavior matches intent for a specific interaction | Multi-step flows, cross-system side effects, failure propagation |
| **E2E** | Complete flow from external trigger to terminal side effect, verified in the real system | Nothing — this is the strongest level |

**The hierarchy is not a checklist.** Use it as a diagnostic: for each criterion, ask "what level is this?" and "is that level sufficient for what this criterion is supposed to confirm?"

When in doubt, elevate. A behavioral test that could have been structural costs almost nothing. A structural check that should have been behavioral produces a false sense of completeness that compounds across campaigns.

---

## When to Use Each Level

**Structural** — Use as a baseline prerequisite, never as a terminal criterion. Structural checks confirm the artifact is ready to run, not that it runs correctly. Always required; never sufficient alone.

**Integration** — Use when the goal involves a handoff between two components, a schema boundary, or a service-to-service call. Required whenever an architecture diagram has edges. One integration test per boundary.

**Behavioral** — Use as the default terminal criterion for most goals. A behavioral criterion answers: "If a user or system performs the triggering action, does the correct thing happen in the real system?" This is the minimum bar for any success criterion that describes user-observable behavior.

**E2E** — Use when the goal involves a full user workflow, a business flow with multiple steps, or a multi-component system where the behavioral level cannot confirm cross-system correctness. Required for any goal with ≥2 system boundaries or ≥2 distinct user flows.

---

## Structural-to-Behavioral Mapping

The table below shows common structural-only checks and what their behavioral counterparts look like. The structural check is not wrong — it should still pass. But it cannot be the only criterion.

| Structural check (insufficient alone) | Behavioral counterpart (required) |
|---------------------------------------|-----------------------------------|
| `tsc` compiles clean | Click node in graph → details panel opens and displays correct data |
| Build passes | Authenticated user performs action → realtime event received by client within 5s |
| Schema migration runs without error | New field appears with correct value in API response after create/update call |
| `eslint` passes with zero warnings | Form validation rejects invalid input and surfaces the correct error message |
| `cargo check` / `go vet` succeeds | Service under load returns correct responses with p99 latency within SLA |
| Unit tests pass (all mocked) | Integration test confirms two real components exchange the expected payload at the boundary |
| Docker image builds | Container starts and responds to health check; first real request returns 200 |

**Note on the first two rows:** These are the required examples from the story specification and are representative of the most common failure mode. `tsc clean` → `click node, panel opens` and `build passes` → `authenticated user receives realtime event within 5s` appear repeatedly in goal reviews where structural checks were accepted as terminal criteria.

---

## Anti-Patterns: Structural Checks That Pass While Behavior Is Broken

These are the most common structural-only criteria that appear in goal drafts and produce false completeness:

**1. "TypeScript compiles with zero errors"**
- What it misses: A component can compile and still call a function with incorrect arguments at runtime (if the types were widened), render wrong data, or silently swallow an async error.
- Behavioral replacement: Render the component in a real browser. Confirm the expected UI state is visible after the triggering action.

**2. "All tests pass"**
- What it misses: If tests mock the system boundary, they confirm internal logic only. The real integration may be broken.
- Behavioral replacement: At least one test must hit the real system boundary — no mock of the component under test's external interface. Grep confirms no mock of the boundary in the integration test file.

**3. "CI pipeline is green"**
- What it misses: CI runs the tests that were written. If the tests are structurally-focused, CI being green means the tests passed — not that the system works.
- Behavioral replacement: CI green is a gate, not a criterion. Add an explicit behavioral criterion: what user action in the deployed environment produces what observable outcome?

**4. "Schema validation passes"**
- What it misses: A schema can be valid while the data it shapes is computed incorrectly, missing required runtime context, or serialized in a way that breaks the consumer.
- Behavioral replacement: Consumer reads the produced artifact and acts on it correctly. Not just that the artifact exists and validates.

**5. "No lint errors"**
- What it misses: Everything that happens at runtime.
- Behavioral replacement: Lint is a code-quality gate, not a behavioral criterion. Do not include lint-pass as a success criterion unless the goal is specifically about code quality tooling.

**6. "Migration runs cleanly / no errors in migration log"**
- What it misses: Whether the migrated data is correct; whether existing queries still return the right results; whether the application reads the new schema correctly.
- Behavioral replacement: Query the database after migration and confirm row counts, field values, and FK integrity are correct. Confirm the application renders data from the migrated schema correctly in at least one end-to-end read path.

---

## Actionable Guidance for Goal Drafters

For each criterion in the goal draft, apply this three-question check:

1. **What level is this?** (structural / integration / behavioral / E2E)
2. **Is that level sufficient?** (structural alone is never sufficient; integration alone is insufficient for user-facing goals)
3. **What does the real system do?** (the criterion must name an observable action and its observable result — not just a check that something is syntactically valid)

If a criterion cannot answer question 3, it is structural. Elevate it.

**Quick audit:** Read through the success criteria. If you can imagine a scenario where all criteria pass but the feature is broken from a user's perspective, at least one criterion is at the wrong level.

The adversarial agents receive this reference. They will flag any criterion that is satisfiable by structural verification alone. Fix those before presenting the goal.
