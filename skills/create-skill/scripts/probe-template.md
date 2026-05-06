# Goal: Probe {{name}}

Make one small, conservative change to `{{target}}`. The change must affect code that executes at runtime — documentation fixes, comment additions, and JSDoc updates do not qualify and will score zero. What matters is exhaustive end-to-end cone verification. Expect to spend roughly 1 part on the change and 8 parts on cone testing (L0→L1→L2). A 2-line fix with 10 verified escape points is better than a 50-line refactor with 2 checks.
{{keyFilesNote}}
## Architecture

```flowchart LR
  A["{{target}}"] --> B["① Change\none small fix"]
  B --> C["①①①①①①①① Verify\nL0 → L1 → L2 → HF → 3×"]
  C --> D[Open micro-PR]
  D --> E["process sleep 15min"]
  E --> F[Wake: CI green]
  F --> G[Update CLAUDE.md cache]
```

## Prerequisites

- `EVAL_PROCESS_ID` set (required for `process sleep`)
- Clean git working tree before starting

## Step 1 — Make one change (small)

Explore `{{target}}`. Find the single most conservative improvement that touches a code path executed at runtime: a bug, an untested code branch, a missing guard, a console.log that should use logger, a coupling violation, or dead code that causes silent failures. Make the smallest change that addresses it.

**What does not qualify:**
- Adding or fixing JSDoc / inline comments
- Editing documentation files (.md, SKILL.md, CLAUDE.md) unless that is the only artifact in the target
- Renaming variables for style
- Fixing whitespace or formatting

If nothing code-level is found, take the clean path in Success Criteria.

## Step 2 — Verify exhaustively (large)

Verification is the work. Work through each layer — stop when the layer doesn't apply to your change:

**L0 — The change itself compiles and its direct unit test passes:**
{{verificationBlock}}

**L1 — Direct consumers have no regressions:**
Identify every file in the repo that imports from `{{target}}`. Run their tests. Verify none of the previously-passing tests now fail.
```bash
grep -r "from '.*{{targetName}}" --include="*.ts" -l
```

**L2 — Escape points are unchanged:**
Escape points are the observable interfaces between this package and everything outside it:
- **Exports**: does `npx tsc --noEmit` pass with zero new errors? Are all public types and function signatures backwards-compatible?
- **Events**: if this package emits `agent_events`, do the emitted `source` and `payload` shapes match what consumers expect?
- **DB writes**: if this package writes to the database, do the written rows match the expected schema?
- **Network calls**: if this package makes HTTP calls, do the request shapes and headers remain correct?

Verify each escape point that applies. For each one: show the before shape, show the after shape, confirm they match.

**High-fidelity check (non-gameable):**
{{verificationNote}}

**3× consecutive passes:**
Run the full verification sequence three times without changing anything between runs. All three must be clean — this catches flakiness before the PR is opened.

**Propagate strong verification:**
If during any of the above you discovered a high-fidelity end-to-end check that is not already documented in a nearby `CLAUDE.md`, write 2-3 sentences about it to the nearest applicable `## Verification` section. Include: (1) what the check is and how to run it, (2) what specific failure mode it catches that weaker checks would miss, (3) why you're confident it's non-gameable. Only add it if you genuinely believe it's strong — a check that just re-runs the test suite is not worth adding.

## Success Criteria

- **Code-level change**: `git diff --name-only HEAD` includes at least one `.ts` or `.tsx` file that is not a CLAUDE.md, SKILL.md, or documentation file
- **Scoped**: `git diff --name-only HEAD` shows only files within `{{target}}` (plus `CLAUDE.md` updates)
- **L0 passes**: unit tests for the changed code pass
- **L1 passes**: no previously-passing tests in direct consumers now fail
- **L2 verified**: each applicable escape point (exports, events, DB writes, network calls) is explicitly checked and confirmed unchanged
- **High-fidelity check passes**: the check from the CLAUDE.md cache runs and passes
- **3× stability**: full verification sequence runs 3 times consecutively with zero failures
- **PR opened**: description names the specific change AND lists every escape point checked with its result
- **CI green after wake**: call `npx duoidal process sleep --interval "15 minutes"` after opening PR — never bash sleep — verify CI green on resume
- **CLAUDE.md updated**: `## Verification` in the nearest CLAUDE.md is updated with any newly discovered strong end-to-end checks — each entry includes what it catches and why it's non-gameable, not just how to run it
- **Clean path**: if no code-level change was found, still run L0–L2 to verify the target is healthy, update `## Verification` in the nearest CLAUDE.md with what was confirmed, and open a PR with only that CLAUDE.md change

## Metrics

None — all criteria are pass/fail.

## Constraints

- Open all PRs as **draft** (`gh pr create --draft`) — never ready-for-review
- One change only — do not fix multiple issues in the same PR
- Do not add new dependencies
- Do not rewrite — the change should be as small as possible
- If a fix requires touching files outside `{{target}}`, open a GitHub issue instead and take the clean path
- `npx duoidal process sleep --interval "15 minutes"` to wait for CI — never bash sleep
- `npx duoidal process amend` if scope needs adjustment mid-investigation

## Post-Loop Action

[Left blank for the dispatch skill to fill in based on the chosen execution path.]
