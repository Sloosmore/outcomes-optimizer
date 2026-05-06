# Dispatch Steps

Individual pipeline steps executed as part of the dispatch flow. The primary step is `launch.ts`, which builds a bash script and starts it in a named tmux session.

Key files: `launch.ts` (tmux session launcher), `process-lifecycle-adapter.ts` (marks process active/completed/failed in DB), `pr.ts` (PR creation helper), `process.ts` (process status queries), `slug.ts` (slug utilities), `worktree.ts` (worktree path helpers).

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
