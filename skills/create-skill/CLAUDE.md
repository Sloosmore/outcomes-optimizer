# skills/create-skill

Version-controlled skill that conducts an interview, generates a verifiable GOAL.md through an adversarial review loop, and presents it for approval. Output: `workspace/goal-<slug>.md`.

Subdirectories:
- `evals/` — Evaluation harness (two-tier: structural + LLM judge)
- `references/` — Validation examples, blast radius, interaction testing, simulation references
- `scripts/` — Goal probing utilities

See `SKILL.md` for the complete skill specification.

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
