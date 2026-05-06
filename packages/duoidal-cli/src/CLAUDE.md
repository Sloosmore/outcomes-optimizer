# duoidal-cli/src

Entry point and top-level composition for the `duoidal` CLI.

- `index.ts` — Commander root program: registers all subcommands (auth, sandbox, resource, process, etc.) and calls `program.parseAsync`
- `commands/` — one file per subcommand tree (sandbox, auth, execute, repo, github, process, credential)
- `lib/` — shared utilities: config/token file I/O, auth guard, Supabase client helpers, sandbox meta
- `providers/` — credential provider adapters (Anthropic, GitHub) for `duoidal sandbox link/unlink`

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
