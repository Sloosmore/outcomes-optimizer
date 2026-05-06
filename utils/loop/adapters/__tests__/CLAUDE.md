# utils/loop/adapters/__tests__

Unit and E2E verification for the loop adapters.

- `open-pr.unit.test.ts` — vitest unit tests for `openPRAdapter`: branch safety guard, workspace stripping, git command sequencing, and PR creation logic against mocked `execSync`.
- `open-pr.e2e.ts` — manual E2E verification script that runs `openPRAdapter` against real GitHub: launches a child loop in a worktree with `--pr`, polls until a PR appears, then asserts the PR exists and the diff is clean. Does NOT assert auto-merge (removed).

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
