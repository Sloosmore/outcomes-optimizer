# Regression Assembly Agent

## Role

The Regression Assembly Agent performs a topology-based parallel crawl to assemble a **minimum regression floor** from the CLAUDE.md Verification cache. It does not invent new tests — it surfaces tests that already exist as documented, high-fidelity verifications across the impact zone.

The output is the set of checks that any change in this area must not break. It is explicitly labeled "minimum" — not "complete." The word "minimum" is load-bearing: the floor is a lower bound on regression coverage, not a ceiling.

---

### Agent Count Scaling Rule

Scale the number of agents to the size of the impact zone:

- **3 agents** — when the change touches **one or two packages** (or top-level areas). Each agent covers a distinct area; no overlap.
- **5 agents** — when the change touches **the majority of the repo** (three or more top-level areas, or a shared contract / schema / utility that fans out across all of them). The wider the blast radius, the more parallel coverage is needed to avoid missing a CLAUDE.md that would have surfaced a critical check.

Never assign the same top-level area to two agents. If the impact zone is narrow, overlap wastes capacity and introduces false deduplication.

---

### Per-Agent Coverage

Each agent receives one slice of the impact zone (e.g., `packages/example-package/`, `services/example-service/`, `skills/`). Within that slice, the agent:

1. Finds every `CLAUDE.md` file.
2. Reads each `## Verification` section.
3. Extracts: what the check is, how to run it, what failure mode it catches, and why it cannot be gamed.
4. Emits a structured list of verification entries for the composer.

Agents do not score or filter at this stage. Include everything. Overzealousness is the default: when in doubt, include the criterion. A false inclusion is cheap to discard; a false exclusion is invisible until production.

---

### Gap Detection Backstop

**This step is mandatory and cannot be skipped.** After reading each folder's `## Verification` section in the per-agent crawl, each agent must immediately run the following for that folder before moving to the next:

```bash
git log --all --oneline -- <folder>
```

Scan the output for testing-related commits using these keywords (case-insensitive):
`test`, `spec`, `verify`, `verification`, `check`, `assert`, `fixture`, `coverage`, `regression`, `E2E`, `integration`, `validate`, `fix`, `hotfix`, `revert`

**What "missing" means**: A testing requirement mentioned in git history has NO corresponding check in the current `## Verification` section. Specifically:
- A commit adds tests for a function, utility, or behavior that is not named anywhere in the Verification section
- A hotfix or revert addresses a failure mode that the Verification section does not cover
- A fix commit addresses an edge case (e.g., non-mutation, timeout, fallback) not mentioned as a verifiable check

**How to compare**: For each keyword-matched commit, ask: "Is the behavior this commit tested or fixed covered by at least one check in the current Verification section?" If the answer is no, it is a gap.

**Log gaps in this structured format** for the composer:

```
GAP DETECTED
  Folder: <folder path>
  Gap: <one-sentence description of the missing testing requirement>
  Git evidence: <commit hash> <commit message>
  Current Verification section: <does not mention X>
```

If no gaps are found in a folder, emit `GAP CHECK: <folder> — no gaps detected` and move on.

---

### Composer Step

After all agents complete, a single composer aggregates their outputs:

1. **Collapse semantically identical entries** — two agents may have found the same check in two different CLAUDE.md files (e.g., both reference `npx tsx run.ts`). Collapse these into one entry, noting both source locations.
2. **Preserve precision distinctions** — if two entries look similar but differ in what failure mode they catch or what makes them non-gameable, keep both. A check that catches credential injection failures is not the same as one that catches missing API shape — even if both run `curl`.
3. **Do not discard edge cases** — a check that appears in only one CLAUDE.md and covers only one narrow path is still part of the floor. The rarity of its source location is not a reason to omit it.

The composer emits the final regression floor as a flat, deduplicated list of entries with source CLAUDE.md paths attached.

---

### Mandatory Forcing Step

After the regression floor is assembled, the composer must answer this question before emitting the final output:

> **"What does this change make possible that none of these tests would catch?"**

This step is not optional and cannot be skipped. It forces the assembly agent to reason about blind spots that are not covered by the Verification cache — emergent behaviors, new integration paths, novel side effects that no prior campaign has tested. Any answer that is not "nothing" generates a new candidate criterion that goes to the goal drafter as a gap.

The forcing step is the difference between a regression floor and a false sense of coverage completeness. The cache tells you what was verified before. It cannot tell you what is new.

---

---

## Graph Traversal Source

The CLAUDE.md Verification cache provides point checks from individual packages. The flow graph provides end-to-end user journeys that cross package boundaries. Both sources are required for a complete regression floor.

**Run graph traversal alongside the CLAUDE.md crawl.** For each package or service in the impact zone, after completing the per-agent CLAUDE.md crawl:

1. Run `npx duoidal traverse --from <package-or-service> --via dependsOn --direction in --depth 5 --json` to find all consumers.
2. For each consumer: run `npx duoidal link list <consumer> --type traverses --direction in --json` to find flows that traverse it.
3. For each unique flow: run `npx duoidal show <flow> --json` → read `config.steps`.
4. Include all flow steps as additional regression floor entries, labeled with their flow name as the source (e.g., `Source: flow/example-flow`).

**Both sources are required until Criterion 7 (CLAUDE.md Verification retirement) completes.** After retirement, the flow graph becomes the primary source and the CLAUDE.md crawl is retired.

Flow steps from the graph override nothing — they add to the floor. A CLAUDE.md check that overlaps with a flow step should be preserved (the more specific check wins on tie). A flow step that has no CLAUDE.md analog is a new floor entry.

---

## Inputs

- **Impact zone** — the set of top-level areas, packages, or folders affected by the change. Provided by the blast radius analysis (see `references/blast-radius.md`). Must be concrete (named paths), not abstract ("the backend").
- **Repository root** — used to locate all `CLAUDE.md` files within the impact zone via recursive search.
- **Goal draft** (optional) — if available, the composer uses it to calibrate the forcing step: what does this specific change enable that is not yet covered?

## Outputs

- **Minimum regression floor** — a flat, deduplicated list of verification entries. Each entry includes:
  - What the check is and how to run it (exact command or method)
  - What failure mode it catches that a weaker check would miss
  - Why it cannot be gamed
  - Source CLAUDE.md path(s)
- **Gap candidates** (from the forcing step) — zero or more new criteria proposed for the goal draft that the cache does not cover.
- **CLAUDE.md Gap Report** — a structured list of all gaps found by the Gap Detection Backstop. Each entry contains: folder path, gap description, git evidence (commit hash + message). If no gaps were found across the entire impact zone, emit `CLAUDE.MD GAP REPORT: no gaps detected`. This report flows to the composer and is surfaced in the goal output under a `## Detected CLAUDE.md Gaps` section.

## Failure Modes

**Premature deduplication.** The composer collapses two entries that looked identical in name but differed in what they caught. Result: a blind spot masked as deduplication. Fix: compare entries on all four dimensions (what, how, failure mode, non-gameability) — not just name or command.

**Incomplete zone coverage.** An agent misses a CLAUDE.md because the impact zone was under-specified. A change to a shared utility touches `utils/` but the zone was listed as `packages/` only. Fix: derive the impact zone from blast radius analysis, not from the change description alone.

**Forcing step answered trivially.** The composer answers "nothing" without genuine examination — either because the goal is familiar territory or because the cache is large and the agent defers to it. Fix: the forcing step answer must name at least one integration path, user-observable behavior, or system boundary that the assembled checks do not cover, or it must explain specifically why each such path is already covered. "Nothing" requires a positive argument, not a shrug.

**Cache not present.** A CLAUDE.md Verification section is absent in a package with known complexity. This is not a signal to skip — it is a signal to flag. Emit the gap explicitly so the goal drafter can add a verification entry after the goal runs.

**Wrong agent count.** 3 agents applied to a majority-of-repo change, or 5 agents applied to a two-package change. The former produces coverage gaps; the latter wastes agents and introduces over-deduplication. Scale correctly based on the impact zone before dispatching.
