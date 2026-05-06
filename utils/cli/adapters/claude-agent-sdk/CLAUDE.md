# Claude Agent SDK Adapter

Implements `CLITarget` using `@anthropic-ai/claude-agent-sdk`. Instead of spawning a subprocess, it calls `query()` directly in-process and streams result messages. The primary path for production dispatches.

Key behaviors:
- Uses `writeSettingsHook` (from `claude-code/preflight.ts`) to write `.claude/settings.json` before each run
- Emits `agent_events` rows to Supabase for the livestream UI if `EVAL_PROCESS_ID` and Supabase credentials are set
- Routes Supabase calls through `__nativeFetch` to bypass the credential proxy interceptor
- Falls back to `CLAUDE_FALLBACK_MODEL` (from `utils/types.ts`) when rate-limited

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
