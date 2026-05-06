# agent-media/src/state

Video job state management. `jobs.ts` persists the in-flight and completed video generation jobs to `.agent-media/jobs.json` (relative to the working directory, or `AGENT_MEDIA_STATE_DIR` if set).

Key behaviors:
- `saveJobs()` writes atomically: writes to `jobs.json.tmp` then renames — a crash during write cannot leave a corrupt state file
- `getStateDir()` validates that `AGENT_MEDIA_STATE_DIR` is absolute and that the default path does not escape the working directory (path traversal guard)
- `cleanupOldJobs()` removes completed/failed jobs older than a configurable cutoff (default 24h)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
