# Docs

This folder contains project documentation. Keep it lean and tied to code.

## Structure

| Path | Purpose |
|------|---------|
| `docs/skills/` | Skill specifications and guidelines |
| `docs/utils/` | Documentation for utilities in `utils/` |
| `docs/driver-analysis/` | Driver discovery analyses for tracked metrics |
| `docs/goals/` | Improvement goals dispatched from driver analyses |
| `docs/ROADMAP.md` | Project roadmap and milestones |

## Rules

- **No arbitrary files.** Only create documentation that fits a purpose above.
- **No slop folders.** Don't create `debates/`, `plans/`, `test-plans/`, `workspace/`, or similar ad‑hoc folders.
- **Mirror code structure.** Utility docs live in `docs/utils/` and should track real code.
- If a document doesn't map to code or active plans, remove it.

---

# Skills (Single Source)

## Skills Spectrum (HOW → WHAT)

Skills exist on a spectrum from HOW (tool interfaces) to WHAT (orchestration):

| Position | What it is | Example | Refs? |
|----------|------------|---------|-------|
| **HOW (tools)** | Stable interfaces to external systems | `agent-browser`, `agent-email` | No |
| **HOW (impl)** | Platform-specific implementations | `create-account` | Yes (gmail, substack) |
| **Mixed** | Compositions of implementations | `onboard-user` | Maybe |
| **WHAT** | Pure orchestration/strategy | `run-campaign` | No |

**Guideline:** HOW skills should not import WHAT skills. Keep tool interfaces stable.

## Skill Creation (Minimal)

Each skill is a SKILL.md with:
1) **Frontmatter** (name, description, imports)
2) **Body** (procedure / workflow)
3) **Rubric** (success criteria)

```yaml
---
name: new-skill
description: What this skill accomplishes
imports: [agent-browser, agent-email]
---

(body to be filled through execution)

---
rubric:
  check: "specific success criteria here"
  artifacts:
    - type: link
      spec: "URL returns 200"
---
```

## Decoupling Principle

Split work into independent bits, evaluate each, then compose. This reduces
failure blast radius and enables parallel progress where dependencies allow.

**Example:**
```
post-to-instagram
├── create-account      ← sequential dependency
│   ├── fill-signup
│   └── verify-email
├── login               ← blocks content posting
└── create-content      ← decoupled from account flow
    ├── generate-image
    └── write-caption
```
