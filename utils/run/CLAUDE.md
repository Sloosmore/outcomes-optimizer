# Utils Run

The single-epoch execution harness. `run(input)` orchestrates: validate prompt → get CLI target → validate environment → run preflight → sync skills → execute command → run postflight.

`executor.ts` handles the actual process spawning (or SDK `executeQuery` call), rate-limit detection, and fallback model retry. OAuth token routing is handled here: if `ANTHROPIC_API_KEY` looks like an OAuth token (`sk-ant-oat*`), it is moved to `CLAUDE_CODE_OAUTH_TOKEN`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
