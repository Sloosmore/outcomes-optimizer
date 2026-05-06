# Loop Adapters

Adapters for specific loop behaviors.

`open-pr.ts` — `openPRAdapter(opts)` strips `workspace/` from the git index, commits, pushes with `--force-with-lease`, and creates a PR against `main`. Does NOT enable auto-merge — the PR waits for human approval and all CI to pass. Called by `executeLoop` when `--pr` is set and the loop completes.

`progress-adapter.ts` — `StoryProgressAdapter.calculateProgress(workspaceDir)` reads `workspace/state.json` and the active `prd-NNN.json` to compute a 0.0–1.0 progress ratio (`stories_passed.length / stories.length`). Returns `null` if any required file is missing or malformed. Called by the loop to write `progress` to the process DB row after each epoch.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
