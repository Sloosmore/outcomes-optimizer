# create-skill/references

Domain knowledge files referenced by the create-skill skill during goal drafting. Contains:

**Domain knowledge (referenced by role files):**
- `blast-radius.md` — L0–L4 dependency cone framework for tracing the impact of a change
- `interaction-testing.md` — verification hierarchy (structural → integration → behavioral → E2E)
- `multi-component-testing.md` — guidance for goals that touch multiple system components
- `simulations.md` — adversarial simulation templates for stress-testing success criteria
- `validation-examples.md` — worked examples of strong vs. weak verification

**Agent role files (dispatched by SKILL.md in feature mode):**
- `regression-assembly.md` — topology-based parallel crawl that assembles a minimum regression floor from the CLAUDE.md Verification cache; scales 3 agents (1-2 packages) or 5 agents (majority of repo)
- `new-criteria-validation.md` — three parallel agents (testability, environmental feasibility, assumption cost) that validate newly proposed criteria before the user sees them
- `implementation-perspective.md` — two agents (information flow analysis, behavioral assertion extraction) that convert implementation observations into observable behavioral criteria
- `adversarial-red-team.md` — generates "trivially compliant but wrong" implementations for each criterion; sharpens proof methods; works alongside the oversight skill
- `non-functional-historical.md` — two agents (git history scan for failure patterns, non-functional baseline for performance/security/cost constraints)

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
