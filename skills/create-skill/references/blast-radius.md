# Blast Radius Analysis

## Applicability Gate

**Before tracing any dependency cone, apply this concrete check:**

> "Does any other artifact in the system import, consume, compile against, or depend on the artifact being changed?"

- If **NO** → skip blast radius analysis entirely
- If **YES** → trace the dependency cone using the L0–L4 framework below

### What SKIPS blast radius analysis

The following categories pass the gate as NO and require no cone tracing:

- Documentation files (READMEs, changelogs, inline comments)
- Design proposals and architecture documents
- Content creation tasks (copy, marketing, blog posts)
- Research tasks and reports
- Metric collection scripts with no consumers
- Visual mockups, wireframes, CAD/3D designs
- Hardware design documents
- Any goal where no artifact in the system imports, consumes, compiles against, or depends on the changed artifact

The gate is a **concrete check**, not a judgment call. Ask: "Does X depend on Y?" If you cannot name a specific artifact that depends on the changed artifact, the answer is NO.

---

## The Blast Radius Cone (L0–L4 Layers)

When the gate returns YES, trace how far the change propagates. Think of the dependency cone as layers radiating outward from the changed artifact:

- **L0 – Immediate change**: The file itself, the function signature, the schema definition, the config value. Does it compile? Does the unit test for the changed artifact pass?

- **L1 – Direct consumers**: Files that directly import, call, extend, or compile against the changed artifact. Integration tests confirming that each direct consumer still behaves correctly.

- **L2 – Boundary validation**: Integration points — API contracts, data serialization/deserialization, type coercions, schema validation at system boundaries. Do external callers still get the shapes they expect?

- **L3 – UI/Runtime behavior**: What users, operators, or downstream services observe at runtime — UI state changes, latency effects, error messages, operational dashboards. Does the observable behavior at the surface remain correct?

- **L4 – E2E behavior**: Full workflow from trigger to terminal side effect — user completes a flow, event delivered to consumer, data appears in storage. Does the complete business flow work end-to-end?

**These layers are a thinking tool, not a rigid checklist.** Some changes have 2 layers, some have 5. Use this as a guide to ask: "what else could break?" Stop when adding another layer would test infrastructure or flows that have no plausible path back to the changed artifact.

---

## Writing Acceptance Criteria by Cone Layer

When drafting a goal, translate each applicable cone layer into **at least one verifiable acceptance criterion**. The criterion must name what is checked and what "passing" looks like — not just that "consumers are tested" or "nothing breaks downstream."

**Criterion template per layer:**

| Cone Layer | What to verify | Criterion form |
|------------|---------------|----------------|
| L0 – Immediate | The changed artifact itself compiles and has correct unit behavior | "`<command>` → `<expected output or assertion>`" |
| L1 – Direct consumers | Each direct importer/caller still behaves correctly | "`<integration test on consumer>` → `<expected behavior>`" |
| L2 – Boundaries | API contracts, serialization shapes, schema enforcement at system edges | "`<boundary call>` returns `<expected shape/status>`" |
| L3 – Runtime/UI | Observable behavior for users or operators in a running system | "`<user action>` → `<observable outcome>` within `<time>` in `<env>`" |
| L4 – E2E | Full business flow from trigger to terminal side effect | "`<trigger>` → `<observable terminal side effect>` (verified in `<system>`)" |

**Not every layer requires a criterion.** Apply the stack-depth principle: if the changed artifact is high in the stack, L0–L2 usually suffices. If it is low in the stack (shared util, schema, config, contract), require L0–L4.

**Example — auth middleware refactor (low stack → requires L0–L4):**
- L0: `npm test src/middleware/auth.test.ts` — all cases green (valid token, expired, malformed, missing claims)
- L1: `npm test routes/` — all route integration tests pass; no previously-passing test regresses to 401
- L2: `curl -H "Authorization: Bearer <valid_token>" /api/status` → HTTP 200 with claims present in decoded payload
- L3: User logs in with valid credentials → session persists across page refresh (Cypress: `cy.reload()` shows authenticated state)
- L4: Full auth flow — login → access protected resource → logout → re-access returns 401 (E2E test confirms)

See the labeled examples at the end of this file for full worked scenarios at each stack depth.

---

## Stack-Depth Principle

The width of the cone is determined by where the changed artifact sits in the dependency stack.

- **Low in the stack** (utilities, schemas, database contracts, shared config, base infrastructure) → **WIDE cone** — trace L0 through L4. Many things depend on low-level artifacts, so any change ripples far. Missing a layer here means silent breakage in production.

- **Mid-stack** (API handlers, service layer, business logic modules) → **MEDIUM cone** — trace L0 through L3. These artifacts have consumers, but their consumers are bounded. Runtime behavior is observable; full E2E may be disproportionate.

- **High in the stack** (UI components, CLI commands, individual routes, leaf nodes with no dependents) → **NARROW cone** — trace L0 through L2. Leaf nodes have few or no downstream dependents. Deep cone tracing would test the same paths repeatedly without adding signal.

**Heuristic:** The lower in the stack, the more important it is to test all levels. The higher in the stack, the more likely L2 is the appropriate stopping point.

---

## Eight Labeled Examples

### Example 1: Authentication Middleware Refactor

**File:** `middleware/auth.ts`
**Scenario:** Refactoring JWT validation logic — changing how tokens are parsed and claims are extracted.
**Stack position:** Low — consumed by every protected route in the application.
**Cone:** L0–L4

- **L0:** Validate the JWT parsing function itself. Unit tests with valid tokens, expired tokens, malformed tokens, and tokens with missing claims all produce the correct results.
- **L1:** Every protected route that calls `authenticate()`. Integration tests confirming 401 on missing token, 403 on invalid token, 200 on valid token with correct claims extracted.
- **L2:** API contracts — all endpoints using auth middleware return correct status codes and headers. Response shapes for auth errors match documented API contracts.
- **L3:** Session behavior — users stay logged in across page refreshes; malformed tokens produce correct redirect to login; logout clears session and subsequent requests are rejected.
- **L4:** Full auth E2E flow — login → access protected resource → logout → confirm session invalidated → confirm protected resource returns 401 after logout.

---

### Example 2: User Schema Change

**File:** `schema/users.ts` (or database migration)
**Scenario:** Adding a `deleted_at` timestamp field and implementing soft-delete semantics.
**Stack position:** Low — the User type is used across queries, mutations, API responses, and UI rendering.
**Cone:** L0–L4

- **L0:** Schema migration runs cleanly. `deleted_at` column exists in the database. TypeScript type updated; codebase compiles without errors.
- **L1:** All queries using the User model — `findById`, `listUsers`, `updateUser` — correctly handle and filter soft-deleted records. A soft-deleted user is excluded from list queries.
- **L2:** API serialization — deleted users are not returned in list endpoints; the user detail endpoint returns 404 for a deleted user; no endpoint leaks `deleted_at` in contexts where it should be hidden.
- **L3:** UI — deleted users do not appear in dropdowns, search results, or user lists. Pages that previously displayed a now-deleted user handle the 404 gracefully.
- **L4:** Full deletion flow — admin deletes user → user cannot log in → user's content attributions resolve gracefully → no orphaned references in downstream data.

---

### Example 3: Logger Utility Replacement

**File:** `utils/example-logger.ts`
**Scenario:** Replacing direct `console.log` calls with a structured logger that emits JSON.
**Stack position:** Low — imported by nearly every service, handler, and utility in the codebase.
**Cone:** L0–L4

- **L0:** Logger API is unchanged or a compatibility shim is provided. All existing call sites compile without modification. The logger emits valid JSON at all log levels.
- **L1:** Every file importing the logger — all log calls produce JSON output (not plain text); all log levels (debug, info, warn, error) are respected and emitted correctly.
- **L2:** Log drain integration — JSON logs flow correctly to the database or log service; the schema matches expected fields (level, timestamp, message, context); no log entries are dropped.
- **L3:** Operational monitoring — alerts and dashboards that parse log output continue to fire correctly; log-based metrics remain accurate; no alert regressions caused by format changes.
- **L4:** Full operational flow — error occurs in production → structured log emitted → monitoring alert triggers → on-call notified via expected channel.

---

### Example 4: Database Connection Pool Config

**File:** `config/database.ts` (or environment config)
**Scenario:** Reducing the PostgreSQL connection pool from 20 to 10 connections.
**Stack position:** Low — all database operations share this pool.
**Cone:** L0–L3

- **L0:** Config change is applied. Pool size confirmed via `pg_stat_activity` query showing max 10 connections from the application process.
- **L1:** All queries execute without connection timeout errors during normal load. No `ConnectionPoolExhausted` errors in logs at baseline traffic levels.
- **L2:** Behavior under concurrent load — 10 simultaneous requests do not starve or error; queue depth remains manageable; connection wait time stays within acceptable bounds.
- **L3:** User-facing latency — p99 response time at expected load remains within SLA; no user-visible errors or degradation attributable to pool exhaustion.

**Note:** No L4 — this is infrastructure tuning. No business flow depends on the pool size value itself. If L0–L3 pass, end-user workflows are unaffected.

---

### Example 5: HTTP Client Library Swap

**File:** `lib/http-client.ts`
**Scenario:** Replacing `axios` with native `fetch` across all service-to-service calls.
**Stack position:** Low-mid — all outbound HTTP calls route through this abstraction.
**Cone:** L0–L3

- **L0:** `lib/http-client.ts` exports the same interface (`get`, `post`, `put`, `delete`, etc.). TypeScript compiles. No call sites require modification.
- **L1:** All callers of the HTTP client — integration tests confirm requests still reach services with correct headers, payloads, and timeouts honored.
- **L2:** Error handling — network errors and 4xx/5xx responses produce the same error shapes as before, so callers do not need updating. Timeout behavior is equivalent.
- **L3:** Behavior under failure — retry logic, timeout behavior, and circuit breakers behave identically to the previous client under degraded network conditions.

**Note:** No L4 — this is a library internals change. End-user workflows are unaffected if L0–L3 pass. There is no new business capability to verify end-to-end.

---

### Example 6: Single API Route Handler

**File:** `routes/api/users/[id]/profile.ts`
**Scenario:** Adding an optional `bio` field to the user profile update endpoint.
**Stack position:** High — leaf node; no other code calls this handler.
**Cone:** L0–L2

- **L0:** Handler logic is correct — the `bio` field is saved to the database when provided. The field is optional; requests without a `bio` still succeed and do not overwrite existing data.
- **L1:** Integration test for this endpoint — `PATCH /api/users/:id/profile` with and without `bio` returns the expected response shape and status code.
- **L2:** E2E test for the profile edit flow — user opens profile page → edits bio → saves → bio appears correctly on the profile view.

**Note:** No L3/L4 — this is a leaf endpoint. No other service consumes it, so there are no downstream runtime behaviors or business flows to verify beyond the profile edit flow itself.

---

### Example 7: Event Bus Interface Rename

**File:** `interfaces/event-bus.ts`
**Scenario:** Renaming `emit()` to `publish()` and `on()` to `subscribe()` in the shared EventBus contract.
**Stack position:** Very low — this is a contract used by all services that communicate via events.
**Cone:** L0–L4

- **L0:** Interface updated. All TypeScript callers updated to use the new method names. `tsc` passes with zero errors across the entire codebase.
- **L1:** All event emitters (`publish()` calls) and all event listeners (`subscribe()` calls) across every service. Integration tests confirm that publishing an event causes the correct subscribers to receive it.
- **L2:** Event routing — events published by Service A are received by Service B with correct payload and ordering. Dead-letter queue for unhandled events still works. Schema validation at event boundaries passes.
- **L3:** Real-time features — live notification delivery, presence indicators, and collaborative edit events all function correctly from a user perspective.
- **L4:** Full event-driven flow — user action triggers event → event routed through bus → all downstream subscribers process it → side effects are visible in the UI and in persistent storage.

---

### Example 8: Non-Code Task — Design Proposal

**Task:** "Write a design proposal for the push notification system architecture."
**Applicability gate result:** SKIP

No existing artifact imports, consumes, compiles against, or depends on a design document. Design proposals describe intended future architecture; they do not modify artifacts that other artifacts depend on.

**What success criteria should verify instead:**
- Document completeness — all required sections present (problem statement, proposed architecture, tradeoffs, rollout plan)
- Architectural clarity — a peer engineer can describe the proposed system from the document alone
- Tradeoff analysis — at least two alternatives considered with explicit reasoning for the chosen approach
- Alignment with existing infrastructure constraints documented in the codebase

**Do NOT apply cone tracing.** Cone tracing on a design document is a false positive — it would force verification of a system that does not exist yet, producing noise with no signal.
