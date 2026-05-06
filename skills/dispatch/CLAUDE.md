# skills/dispatch

Version-controlled skill that takes an existing goal file and dispatches it to a runner (cloud SSH, agent-interceptor, local tmux, or GitHub Actions). Does NOT interview or generate goals — that is the `create-skill` skill's responsibility.

Subdirectories:
- `references/` — Runner-specific dispatch instructions (cloud.md, agent-interceptor.md, feature.md, github-actions.md)

See `SKILL.md` for the complete skill specification.

> E2E verification requirements live in the flow graph — see flow skills via `npx duoidal search "flow/" --type skill`

## Local Cache Sync

When dispatching to a remote server for the first time, the remote may lack the local skills cache. Sync it before dispatch:

```bash
# Sync bundled skills cache to remote before first dispatch
scp -r ~/.config/duoidal/skills/ $USER@$HOST:~/.config/duoidal/skills/
# Or use cp for local worktree dispatch:
cp -r ~/.config/duoidal/skills/ /tmp/skills-sync/
```
