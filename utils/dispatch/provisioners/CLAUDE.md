# Dispatch Provisioners

Each provisioner implements the `Provisioner` interface (`provision(ctx, slug, opts)` + `teardown(ctx, slug)`). Provisioners are selected by name and composed at runtime by `provision.ts`. The worktree provisioner is the primary one — it creates a git worktree, creates a process row in the DB, and writes `workspace/goal.md`.

Key provisioners: `worktree.ts` (git worktree + process init), `compose.ts` (runs `docker compose up -d --wait` from `compose.yml` in the worktree, handles pnpm install/package builds/services via Docker Compose). Service-level operations (credential-proxy, dashboard, supabase-branch) are now handled by compose services defined in `compose.yml`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
