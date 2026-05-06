# agent-livestream/bench

Standalone benchmarking scripts for measuring agent-livestream latency end-to-end.

- `diagram-bench.mjs` — measures wall-clock time from request to diagram artifact output across multiple models and prompts
- `research-bench.mjs` — runs a full agent loop (prompt → SSH → mermaid → artifact) using the LiteLLM-backed `messages.create()` path
- `litellm-bench.yaml` — LiteLLM proxy config used by the benchmark scripts

These scripts are run manually against a live instance, not in CI.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
