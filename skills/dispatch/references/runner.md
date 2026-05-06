# Reference: Runner — Dispatch via duoidal execute

All goals dispatch using `duoidal execute`. The CLI handles worktree provisioning, process tracking, and tmux launch. No SSH orchestration required — call the command wherever the CLI is installed.

## Prerequisites

- CLI installed: `npx duoidal` or `npx duoidal` resolves to the built binary
- DB credentials: SKILL_NETWORKS_DATABASE_URL set (or DATABASE_URL)
- Auth token: ~/.config/duoidal/token.json or DUOIDAL_TOKEN env var

## Dispatch

```bash
# Goal file must be uploaded first (done by dispatch skill via execute command)
duoidal execute [goal-path] --assign-to [agent-name] --epochs [n]
# OR
node /path/to/worktree/packages/duoidal-cli/dist/index.js execute [goal-path] --assign-to [agent-name]
```

## SSH Credentials (if needed for remote sandbox)

If dispatching to a remote sandbox, credentials are stored in the DB — never hardcoded here:

1. Look up the sandbox resource: `duoidal search openclaw --type sandbox`
   - The resource `config.host` field contains the target host address
2. Look up the linked credential resource (link_type='uses') for the SSH key reference
   - The credential resource `config.keyPath` contains the path to the SSH key
   - The credential resource `config.dopplerProject` contains the Doppler project name for secrets

These values come from the DB at runtime via `getAdapter()` — they are never hardcoded here.

## Completion

The loop writes `COMPLETE` to workspace/progress.md when the goal succeeds.

## Monitoring

After dispatch, verify the skill resource and process were created:

```bash
# Check that the skill resource exists
npx duoidal search "skill/<slug>" --type skill --json

# Check that a process was created and linked
npx duoidal process list --json | jq '.[] | select(.resource_name == "skill/<slug>")'
```
