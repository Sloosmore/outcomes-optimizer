# duoidal-cli

CLI for provisioning and managing Hetzner VMs for agent execution.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
## CLI Access Patterns

There are two ways to invoke `duoidal`: the globally installed binary and a local worktree build. Use the right one for the task:

### Global (`npx duoidal`)

The published npm version. Always available without any local build step. Reads only system env vars and `~/.config/duoidal/`. Use when you don't need to modify the CLI source — for provisioning, linking credentials, or querying resources in a stable environment.

```bash
npx duoidal sandbox provision --name my-sandbox
npx duoidal resource list
```

### Local build (`pnpm exec duoidal`)

The binary compiled from the current worktree. Resolves to `<worktree>/node_modules/.bin/duoidal`, which points to `<worktree>/packages/duoidal-cli/dist/index.js`. Modify source → rebuild → the next `pnpm exec duoidal` call picks up changes immediately.

```bash
# Rebuild after source changes
cd packages/duoidal-cli && pnpm build

# Invoke the local binary
pnpm exec duoidal sandbox provision --name my-sandbox
```

### Sub-worktree pattern (test CLI changes in isolation)

To test CLI changes without affecting your main worktree's binary, create a sub-worktree from the current branch, make edits there, rebuild, and test. The parent worktree's compiled binary is untouched throughout.

```bash
# From the main worktree
git worktree add .worktrees/cli-experiment -b cli-experiment

# Work in the sub-worktree
cd .worktrees/cli-experiment/packages/duoidal-cli
# ... make changes ...
pnpm build
pnpm exec duoidal --help   # tests only the sub-worktree's binary
```

Each worktree owns its `node_modules/.bin/duoidal` — isolation is free because pnpm resolves binaries relative to CWD.

### Concurrent agents

Multiple agents calling `pnpm exec duoidal` simultaneously works correctly. Each agent resolves to its own worktree's compiled binary via pnpm's CWD-relative binary resolution. No locking or coordination needed.

## Adaptive Aliases

`duoidal` uses `cli-adaptive` to learn from unknown-command mistakes and promote persistent aliases.

### How it works

- **Unknown command**: typing an unrecognized command prints a suggestion and exits 1.
- **Alias creation**: run the real command with `--alias-from <shorthand>` to create a permanent alias.
- **Alias use**: the shorthand is silently rewritten to the real command on every future invocation.

### Storage

Aliases are stored at `~/.cli-adaptive/duoidal/aliases.json` — one entry per alias. This path is **not version-scoped**, so aliases persist across duoidal upgrades. If a command is renamed or removed, its alias will silently fail (no match found); remove stale entries manually.

### Flags

- `--alias-from <shorthand>` — after the command succeeds, map `<shorthand>` to it.
- `--alias-reason <reason>` — optional label stored alongside the alias explaining why it exists.

### Example

```bash
# First time: command succeeds, alias is saved
duoidal sandbox provision --name my-box --alias-from prov --alias-reason "too much to type"

# Future invocations: `prov` is rewritten to `sandbox provision` before parsing
duoidal prov --name my-box
```

## Verification

### All three skills bundle correctly

```bash
cd packages/duoidal-cli && pnpm build
ls dist/bundled-skills/
# Expected: create-skill  dispatch  oversight
```

This confirms the postbuild step ran and all skills listed in `skills.manifest.json` were copied into the dist output.

### Manifest is the source of truth — no hardcoded skill lists

```bash
grep -r "create-skill\|oversight\|dispatch" packages/duoidal-cli/scripts/bundle-skills.js
```

The only references to skill names should flow through the manifest read, not as inline string arrays. If a hardcoded list appears, the manifest is being bypassed.

## BFF-only: All Privileged Server Operations

All privileged server operations go through the BFF (`services/agent-livestream`). The CLI client never directly accesses `GITHUB_APP_*`, `SUPABASE_SERVICE_*`, `HETZNER_API_*`, or any other server secret. If a new command needs a privileged operation, add a BFF endpoint — do not add client-side secret handling.

This was violated by `repo-clone` (which read `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` client-side) and fixed in the config-unification goal. Prevent recurrence.

### Why this is stronger than running tests alone

Unit tests can pass while the manifest and the actual bundle drift — e.g., a skill added to `skills.manifest.json` but the copy logic silently skips it due to a path error. The `ls dist/bundled-skills/` check verifies the real filesystem output after a real build, catching that class of drift that tests would miss.
