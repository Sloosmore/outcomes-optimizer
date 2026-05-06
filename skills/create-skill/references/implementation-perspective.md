# Implementation Perspective

## Role

Two agents that analyze data flow through the system and extract behavioral assertions from it. Their combined output converts implementation-level knowledge into acceptance criteria that can actually be verified from outside the system.

This role exists because goal authors frequently write criteria that describe *how the system works internally* rather than *what the system produces externally*. Internal descriptions are untestable by any agent that cannot inspect source code at runtime. Behavioral assertions are testable by any observer — human, automated test, or downstream system.

---

### The Distinction Rule

**Implementation assertions** describe internal system mechanics: what code calls what, which function runs first, how data is transformed inside a component. These are invisible to external observers and cannot be verified without introspecting the running system's internals.

**Behavioral assertions** describe observable outcomes: what a user sees, what an API returns, what appears in a database, what a downstream system receives. These can be verified by any observer with access to the system's output boundary.

**Only behavioral assertions are valid acceptance criteria.** An implementation assertion may appear in the goal's Architecture section as context — but it cannot appear in Success Criteria.

**Labeled example pair:**

- *Invalid (implementation assertion):* "the layout engine is called before render"
  This describes internal call order. No external observer can verify this without tracing the call stack. Even if the implementation changes so that rendering is inlined, a user observing the output would see no difference.

- *Valid (behavioral assertion):* "a centered node appears at coordinates matching the container midpoint"
  This is observable by any agent that can read the rendered output. It is independent of which internal function produced the result. If the implementation changes but the outcome is the same, the criterion still passes. If the implementation changes and the outcome breaks, the criterion catches it.

The pair above is not a coincidence — it shows the same *intent* expressed at two different levels. Agent B's job is to take the implementation observation (which the goal author naturally reaches for) and translate it into the behavioral assertion that actually captures the intent.

---

### Agent A: Information Flow Analysis

Traces how data moves through the system end-to-end for the feature being specified.

For each data input the feature accepts (user action, API call, scheduled trigger, file write), Agent A maps the path:

1. **Entry point** — where does the data enter the system? (UI form, API endpoint, CLI argument, event bus)
2. **Transformation path** — what intermediate states does it pass through? Name components and boundaries, not internal function calls.
3. **Exit points** — where does the data leave the system as an observable side effect? (database row, API response, rendered UI element, file on disk, event emitted)

The output is a data flow map. Each exit point in the map becomes a candidate observation target for Agent B.

Agent A does not judge whether exit points are being correctly handled — that is Agent B's job. Agent A only maps what exists (based on the goal description and any architecture context provided).

**Example for a node-centering feature in a graph layout tool:**
- Entry: user selects "center node" action in the UI
- Transformation path: selection event → layout engine → position calculator → render pipeline → DOM update
- Exit points: (1) node's rendered position in the DOM, (2) node's stored coordinates in the state model (if persisted), (3) any event emitted to subscribers (if the layout engine is observable)

These three exit points become the inputs to Agent B.

---

### Agent B: Behavioral Assertion Extraction

Converts every exit point from Agent A's flow map into a behavioral assertion.

For each exit point, Agent B asks:

> **"What would an external observer confirm to verify that this exit point produced the correct output?"**

The answer must be:
- Observable without inspecting source code
- Expressible as a verification command or user action → observable outcome
- Falsifiable: there must exist a wrong state the system could be in that would cause this assertion to fail

**Translation pattern:**

| Agent A exit point | Agent B behavioral assertion |
|---|---|
| node's rendered position in the DOM | `a centered node appears at coordinates matching the container midpoint` — confirmed by reading bounding box from the rendered viewport |
| coordinates stored in the state model | after centering, reading the persisted node record returns `x = container_width/2, y = container_height/2` within ±1px |
| event emitted to subscribers | subscriber receives a `node.repositioned` event with `{x, y}` matching the container midpoint before the next render cycle completes |

Agent B also runs the inverse check: for each behavioral assertion, does the implementation *need* to work correctly to produce it, or could the assertion be gamed? A gamed assertion (one where the correct value could be hardcoded without engaging the real system) must be strengthened. See `references/multi-component-testing.md` Rule 4 for the lazy path check.

---

## Inputs

- **Goal description and architecture** — the goal's intent, mermaid diagram, and any system context provided by the goal author.
- **Feature scope** — which system components are touched by this change (from blast radius analysis, if available).
- **Draft success criteria** (optional) — if criteria already exist, Agent B compares them against its extracted assertions to find implementation-level criteria that need to be elevated.

## Outputs

- **Data flow map** (from Agent A) — entry point, transformation path, exit points for the feature.
- **Behavioral assertion set** (from Agent B) — one assertion per exit point, expressed as: `[external observer action] → [observable outcome]`.
- **Criteria elevation flags** — if draft criteria were provided, any criterion that is an implementation assertion (not a behavioral assertion) with a suggested behavioral replacement.

## Failure Modes

**Agent A maps internal call chains, not data exit points.** An information flow that lists function names instead of system boundaries is not useful to Agent B. Fix: Agent A must stop at component boundaries and output paths, not internal mechanics. The test: every step in the flow map should be nameable as a component or boundary (e.g., "API endpoint", "database table", "DOM element") — not a function or class name.

**Agent B accepts implementation assertions from the draft criteria without flagging them.** The "layout engine is called before render" example passes unchallenged because it is phrased confidently. Fix: Agent B must apply the distinction rule to every criterion it receives — any criterion that requires inspecting internal call order, function state, or in-memory values is an implementation assertion and must be elevated.

**Exit points with no external observer.** Some internal state changes have no observable exit point — they exist only in memory and are never persisted or emitted. Agent B cannot write a behavioral assertion for these. The correct disposition is not to write a weak assertion ("the state is updated correctly") but to flag the gap: if this change has no observable effect, is the feature actually needed? Surface this to the goal author.

**Behavioral assertions that are still too vague.** "The output is correct" is technically a behavioral assertion (it describes an outcome, not internal mechanics) but provides no verification method. Agent B's assertions must name the specific observable value, the specific boundary, and the specific command or action that would confirm it. Vagueness at the behavioral level is a different failure mode from implementation over-specification, but it is equally disqualifying.
