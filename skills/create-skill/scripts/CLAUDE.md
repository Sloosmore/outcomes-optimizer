# create-skill/scripts

Scripts used by the create-skill skill for automated goal generation workflows. Contains:
- `probe.ts` — selects the next codebase target using staleness-first ordering weighted by git churn, then generates a probe goal using the `probe-template.md` template
- `probe-template.md` — the goal template used for probe goals (conservative one-change, exhaustive verification)

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
