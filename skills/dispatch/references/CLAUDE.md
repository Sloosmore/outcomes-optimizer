# dispatch/references

Reference files for each dispatch execution path. Each file describes a complete, self-contained dispatch procedure for one run type. The dispatch skill loads exactly one reference per invocation.

Contains:
- `cloud.md` — SSH dispatch to the OpenClaw cloud runner (default path)
- `feature.md` — local tmux dispatch for code features going to a PR
- `agent-interceptor.md` — fallback dispatch via the agent-interceptor webhook
- `github-actions.md` — GHA-based dispatch for CI-only goals
- `headless.md` — headless runner dispatch for non-interactive goals
- `post-dispatch-monitor.md` — post-dispatch monitoring procedures

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`
