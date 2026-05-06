# oversight/references

Reference files loaded by the oversight skill for each of its operating modes. Each file defines the algorithm, inputs, and output format for one oversight mode.

Contains:
- `adversarial.md` — adversarial PRD reviewer: diagnoses why an approach is failing and proposes alternatives
- `comparator.md` — PRD comparator: selects the best PRD from multiple candidates
- `diagnose.md` — causal diagnosis: position analysis for understanding current campaign state
- `driver-discovery.md` — metric driver tracer: traces a metric key to its highest-leverage causal driver
- `generator.md` — PRD generator: decomposes a goal into executable stories
- `output-validator.md` — blind validator: evaluates outputs against the goal without knowing how they were produced
- `prd-validator.md` — PRD validator: checks each generated PRD for structural completeness

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
