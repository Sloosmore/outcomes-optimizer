# agent-youtube/src

Source root for the `agent-youtube` CLI.

- `cli.ts` — Commander root: registers all subcommands and dispatches
- `config.ts` — constants (API base URL, default quota limits, retry config)
- `index.ts` — package entry point
- `adapters/` — YouTube API adapter (session-based: factory + session classes)
- `commands/` — one file per CLI subcommand (upload, list, delete, metrics, quota, transcript, whoami)
- `state/` — persistent state: channel info, credentials, quota tracking

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
