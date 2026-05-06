# New Criteria Validation

## Role

Three parallel agents that validate newly proposed acceptance criteria before they go to the user. The goal is to surface broken criteria — untestable, infrastructure-dependent, or assumption-heavy — before they enter the adversarial loop or get committed to a GOAL.md. Catching a bad criterion here costs one review cycle. Catching it after the loop runs costs the entire campaign.

Each agent examines the proposed criteria from a different angle. All three run in parallel on the same draft criteria set. Their findings are merged before the criteria are shown to the user.

---

### Agent A: Testability Check

Examines whether each criterion is precise enough to test from inside the loop.

For each criterion, Agent A asks:

1. **Is the specification precise enough?** A criterion is precise if an executing agent can determine pass or fail without talking to a human. "The feature works correctly" is not precise. "Running `npx duoidal process list --status=completed` returns the process with `id=X` and `completed_at IS NOT NULL`" is precise.

2. **Is the observability infrastructure present?** Can the criterion actually be evaluated using the tools and interfaces available in the execution environment? A criterion that requires reading production logs on a system the loop agent has no access to is not testable.

3. **Are side effects mapped?** If the criterion involves a side effect (writing to a database, sending a notification, creating a file), is there a way to observe the side effect independently? A criterion that states "the email is sent" but has no outbox-inspection path is under-specified.

**Output:** For each criterion, a pass/fail verdict with a one-sentence rationale. Failed criteria get a rewrite suggestion that makes them testable.

---

### Agent B: Environmental Feasibility Gate

Examines whether the criteria are testable given what actually exists in the environment — covering both credentials/infrastructure and categories of criteria that are structurally untestable regardless of what credentials are available.

**Three categories of criteria that are untestable regardless of precision:**

1. **Probabilistic and load behavior** — criteria that require statistically significant sample sizes to evaluate (e.g., "p99 latency under 200ms under production traffic"). These cannot be verified in a single loop run. They belong in a performance testing track, not in per-run success criteria.

2. **Third-party black box internals** — criteria that depend on behavior inside an external system that has no inspection interface (e.g., "the payment processor correctly routes the charge to the acquiring bank"). The loop agent cannot observe inside third-party systems. The criterion must be rewritten to what is observable at the boundary.

3. **Regulatory compliance** — criteria that require legal or compliance interpretation (e.g., "the data handling is GDPR-compliant"). These require human review, not automated verification. Flag for human sign-off and remove from automated criteria.

**Four load-bearing infrastructure items that ALWAYS require user confirmation — NEVER acceptable to assume present:**

- **Auth** — the authentication mechanism (tokens, session keys, OAuth flow) for any service the loop agent will call. Do not assume auth credentials exist or are injected automatically.
- **Database schema** — the current state of the production or staging database schema. Do not assume a migration ran or a table exists. Always verify the schema state before writing criteria that depend on it.
- **Dispatch lifecycle** — the expected behavior of the dispatch system (how goals are queued, how processes are created, what `started_at`, `completed_at`, and status transitions look like). Do not assume this is configured correctly.
- **Process state machine** — the valid states and transitions for a process (e.g., `pending → active → completed`). Do not assume the state machine matches what you expect. A criterion that depends on an invalid transition will fail silently.

**Output:** For each criterion, a verdict: testable / untestable + category. For untestable criteria, a recommended disposition (drop, rewrite, or escalate to human). For load-bearing infrastructure items, a required question for the user before proceeding.

---

### Agent C: Assumption Cost Analysis

Examines the assumptions each criterion makes and asks whether those assumptions are safe.

For each assumption a criterion requires (e.g., "the user is authenticated," "the DB row already exists," "the service is already deployed"), Agent C asks:

> **Is this assumption revertible via a small follow-on goal?**

An assumption is "safe" if it either (a) can be confirmed from the codebase without running anything, or (b) if it turns out to be wrong, fixing it is a small, well-scoped follow-on goal — not a fundamental redesign.

An assumption is "unsafe" if it is baked into multiple criteria such that, if it is wrong, the entire goal must be rewritten. These assumptions must be surfaced to the user before the goal is finalized.

**Example of an unsafe assumption:** A goal assumes that the dispatch system emits a `process.completed` event on job completion. Five criteria depend on observing this event. If the system does not emit this event, all five criteria are invalid. This assumption must be confirmed before the goal is drafted, not discovered during execution.

**Example of a safe assumption:** A goal assumes a config file exists at `config/database.ts`. If it does not, the executing agent can create it in a small follow-on step with no redesign required.

**Output:** A list of assumptions per criterion, each labeled safe or unsafe, with a revertibility cost estimate. Unsafe assumptions become required pre-flight questions for the user or hard-gate prerequisites in the goal.

---

### Merge Step

After all three agents complete, merge their findings:

- Drop criteria that all three agents flag as untestable (no dissent needed — unanimous failure is disqualifying).
- Escalate criteria where Agent B and Agent C disagree on testability — surface the disagreement explicitly rather than silently resolving it.
- For each failed criterion, emit the rewrite suggestion with the highest precision (usually from Agent A).
- For each load-bearing infrastructure item flagged by Agent B, add a prerequisite question to the goal that must be answered before the criteria are finalized.

## Inputs

- **Draft acceptance criteria** — the proposed success criteria for a goal, in the standard format from SKILL.md.
- **Goal context** — goal title, description, and architecture diagram (from the draft GOAL.md). Agents need context to evaluate whether side effects are mapped and whether assumptions are safe.
- **Available infrastructure inventory** (if known) — a list of credentials, services, and environment variables that are confirmed present in the execution environment.

## Outputs

- **Validated criteria set** — a revised list of acceptance criteria that passed all three gates.
- **Dropped criteria** — criteria removed as untestable, with the category from Agent B's feasibility taxonomy (probabilistic, black box, regulatory, or missing infrastructure).
- **Rewrite suggestions** — for each failed criterion, a rewritten version that is testable.
- **User confirmation questions** — for each load-bearing infrastructure item (auth, database schema, dispatch lifecycle, process state machine) that could not be confirmed from the codebase, a question for the user.
- **Prerequisite additions** — unsafe assumptions that must be converted to hard-gate prerequisites.

## Failure Modes

**Testability theater.** A criterion is declared testable because it has a precise command but the command can be faked (e.g., `grep` confirms a string exists in a file, but the file could have been written directly). Agent A must evaluate whether the verification method requires the real system to participate — not just whether the criterion is syntactically precise.

**Environmental feasibility bypassed.** Agent B finds no untestable criteria because it trusted the goal author's implicit assumption that credentials exist or that the environment is configured. Fix: Agent B must explicitly check each criterion against the four load-bearing items (auth, database schema, dispatch lifecycle, process state machine) even if not mentioned in the criteria, and must apply the three untestable-category filters regardless of how precisely the criterion is written.

**Assumption cost underestimated.** Agent C labels an assumption "safe" because fixing it seems small in isolation, but does not account for the number of criteria that depend on it. An assumption used in five criteria is not safe even if fixing it takes one file change. Cost is proportional to dependency count, not fix size.

**Merge resolves disagreements silently.** Two agents disagree but the merge step picks one verdict without surfacing the conflict. The goal author never sees the disagreement and cannot make an informed choice. Disagreements must always be surfaced explicitly — they are the most informative signal the validation step produces.
