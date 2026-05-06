# Multi-Component Testing Reference

**Status: experimental** — apply when the goal involves an architecture diagram with multiple interacting components. Not yet merged into the main create-skill flow. Load this reference explicitly for goals with ≥2 system boundaries.

Evidence from past campaigns shows a consistent failure mode: goals with complex multi-component architectures produce goals with thorough unit tests and weak integration coverage. The executing agent gravitates toward the paths it can control — internal logic, type correctness, happy-path mocks — and avoids the paths it can't — real handoffs between systems, observable output at the boundary, failure propagation across components.

The rules below are the structural correctives.

---

## Rule 1 — The Pairing Rule

For every directed edge in the architecture diagram, there must be at least one integration test that:
1. Confirms the source system produced output
2. Confirms the destination system received and acted on that output
3. Verified in the real system — not a mock of either side

If N components interact, the minimum integration test count grows with the number of edges — not the number of components. A 4-component system with 6 edges needs at least 6 integration tests, not 4.

**Examples across domains:**

- Voice agent → research worker (LiveKit text stream): Integration test confirms the research worker receives the dispatch payload and returns a `ResearchResult` with a real artifact.
- Loop epoch → DB status update: Integration test confirms the process row transitions from `active` to `completed` after the loop signals COMPLETE — not just that the signal was written.
- Proxy → downstream API: Integration test confirms the proxy injects credentials and the downstream API accepts the request — verified by checking the response header, not the proxy log.
- Cron scheduler → poller → process row: Integration test confirms a cron firing results in a `processes` row with `started_at IS NOT NULL` — not just that the scheduler fired.

**Derivation rule for goal authors:** Walk the architecture diagram. For each arrow, write one integration test. No arrow is exempt. If writing the test reveals the handoff is unclear, clarify the handoff before writing the goal.

---

## Rule 2 — E2E Tests Must Be Full-Chain

Every E2E test must:
- **Start at the outermost input boundary** — browser action, CLI invocation, webhook, voice input, API call from an external client. Never start inside a component.
- **Assert at the outermost output boundary** — observable change in the real world: a DB row with the correct value, an HTTP response from a live server, a screenshot showing non-blank content, a file on disk.
- **Use the real system end-to-end** — no mocks, no hardcoded expected values, no adapters that short-circuit the flow.

The diagnostic question: *Could the agent pass this test by hardcoding the expected output without invoking the real system?* If yes, the test is not E2E — it is an observation. Rewrite it so the real system must participate to pass.

**Minimum count:** 2 E2E tests for any multi-component goal. For goals with 4+ components or 2+ distinct user flows, 4+ E2E tests.

**Examples across domains:**

- *Weak (observation):* "The artifact iframe renders on the page." — Agent could inject a srcdoc attribute.
- *Strong (E2E):* "Browser navigates to `/chat/:id`, sends voice input, waits for `artifact-frame`, then `GET {iframe.src}` from the test runner returns HTTP 200 from a live server." — Hardcoding cannot pass this.

- *Weak (observation):* "The DB row has `status = completed`." — Agent could update the row directly.
- *Strong (E2E):* "CLI invocation triggers the loop. Loop runs 2 epochs. After loop exits, `processes.status = 'completed'` AND `workspace/progress.md` starts with `COMPLETE`." — Both must be true; neither can be faked independently.

---

## Rule 3 — Consecutive Pass Requirement

All E2E tests must pass on **3 consecutive runs** before the loop signals COMPLETE.

A single passing run proves the test can pass. Three consecutive passing runs prove the test is not flaky. Flaky infrastructure (WebSocket sessions, SSH connections, port allocation, LiveKit room lifecycle) will fail intermittently. A goal that passes once and fails twice is not done.

State this explicitly in the Success Criteria:

> "E2E tests pass on 3 consecutive runs with no test infrastructure changes between runs."

If the test environment is genuinely non-deterministic (e.g., rate limits, external API latency), document the retry policy explicitly rather than relaxing the consecutive requirement.

---

## Rule 4 — Lazy Path Detection (Adversarial Check)

During the adversarial critique, apply this check to every E2E and integration test criterion:

> "Could the executing agent pass this criterion by taking the simplest path that satisfies the text — without actually completing the real goal?"

Common lazy paths to look for:

| Criterion as written | Lazy path | Corrected criterion |
|---|---|---|
| "artifact-frame renders on page" | Set `srcdoc` attribute instead of `src` URL | "artifact-frame `src` matches `https://{port}.domain/` — not a srcdoc. `GET {src}` returns 200." |
| "research tool returns a result" | Return hardcoded fixture | "Research tool invoked with a novel prompt returns a `ResearchResult` with a port that serves live content from the remote server." |
| "metric value updated in DB" | Write expected value directly to DB | "Metric is computed by querying the real system and stored by the skill. The query is observable (grep confirms it ran). The stored value matches the query output." |
| "tests pass" | Write tests that mock the real call | "Integration tests hit the real system — grep confirms no mock of the system boundary in the test file." |

Flag every lazy path found during adversarial critique. Either tighten the criterion or add an explicit constraint prohibiting the shortcut.

---

## Rule 5 — General Language for Scientific Experimentation

When the goal involves measuring, moving, or optimizing a real-world signal (engagement, latency, quality scores, business metrics), success criteria must describe observable evidence — not implementation steps.

**Principle:** State what changes in the real world, and how to observe it. Never state how to produce the change.

| Implementation-specific (wrong) | Outcome-general (right) |
|---|---|
| "Update the `agent_hours_per_day` metric_snapshots row with the computed value" | "The metric reflects actual agent activity: querying the real system returns a value consistent with the observed process durations for that day." |
| "Run the nightly-report skill to collect engagement metrics" | "After one sleep/wake cycle, the metric shows movement toward the target direction. The stored value is derived from the real system — not written directly." |
| "Modify the poller to set `started_at = NOW()`" | "Processes dispatched by the scheduler have `started_at` set at dispatch time. The gap between `created_at` and `started_at` is ≤ 2 minutes for normally dispatched processes." |

The executing agent determines how to produce the change. The goal only specifies how to confirm it happened in the real world.

---

## How to Apply These Rules During Goal Drafting

**When the goal has an architecture diagram:**

1. Walk every edge in the diagram. Write one integration test per edge (Rule 1).
2. Identify the 2–4 most critical user flows. Write one E2E test per flow (Rule 2).
3. Add the consecutive pass requirement to the Success Criteria (Rule 3).
4. Run the lazy path check on each E2E and integration criterion (Rule 4).
5. Rewrite any success criterion that names a file, function, or implementation step as an outcome (Rule 5).

**When the adversarial critique returns nothing for a multi-component goal:**

This is a strong signal the critique didn't go deep enough. Re-run with this explicit instruction:

> "Walk the architecture diagram edge by edge. For each edge, verify there is an integration test that confirms the handoff in the real system. For each E2E test, apply the lazy path check. Return any edge without coverage or any E2E test that could be gamed."

---

## Merging into Main Flow

These rules are isolated here pending evidence from 2–3 campaigns that they produce better outcomes without inflating goal scope. The merge criteria:

- Integration test coverage visibly improves (pairing rule applied, no uncovered edges)
- E2E tests are full-chain in produced goals (no observation-only criteria)
- Consecutive pass requirement appears in produced goals by default
- Scope stays bounded (≤7 criteria; extra tests are consolidated where possible)

If these criteria are met, the rules merge into `SKILL.md`'s adversarial review step and the pairing rule is added to the goal quality checklist in `simulations.md`.
