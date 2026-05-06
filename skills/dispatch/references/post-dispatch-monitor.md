---
name: post-dispatch-monitor
description: Create a status-check cron after dispatching a goal to OpenClaw. Called by the dispatcher (not the hooks agent).
---

# Post-Dispatch Monitoring

After a goal is dispatched to OpenClaw, wait 10 minutes, run a startup health check, then create a 5-minute status cron so the user gets automatic updates.

## When to use this

Read and execute this reference **only if you are the dispatcher** — the agent in the user's local Claude Code session that sent the `openclaw agent` command and received the "Launched..." confirmation back.

**Do not use this** if you are the hooks agent executing headless.md on OpenClaw. You are not in the caller's session and have no CronCreate tool.

## Step 1: Startup health check (10-minute gate)

Wait 10 minutes after dispatch, then run:

```bash
ssh -i "$OPENCLAW_SSH_KEY" "root@$OPENCLAW_HOST" \
  "docker exec runtime-runtime-1 bash -c '
    SLUG=\"<SLUG>\"
    SHORT_ID=\"<SKILL_SHORT_ID>\"
    if tmux has-session -t \"\$SLUG\" 2>/dev/null; then
      echo \"TMUX: alive\"
    else
      echo \"TMUX: DEAD\"; tmux list-sessions 2>&1
    fi
    LOGFILE=\$(ls -t /root/.claude/projects/-root-dispatch-\${SHORT_ID}/*.jsonl 2>/dev/null | head -1)
    [ -n \"\$LOGFILE\" ] && echo \"JSONL: \$LOGFILE\" || echo \"JSONL: MISSING\"
  '"
```

**If TMUX is DEAD or JSONL is MISSING:**
- Tail the headless log: `ssh -i "$OPENCLAW_SSH_KEY" "root@$OPENCLAW_HOST" "docker exec runtime-runtime-1 tail -50 /root/dispatch/headless-<SKILL_RESOURCE_ID>.log"`
- Report the failure to the user with the last 50 lines of the log
- **Do NOT create the recurring cron** — the loop never started cleanly

**If both pass:** proceed to Step 2.

## Step 2: Create recurring status cron

Call `CronCreate` with:
- `cron`: `*/5 * * * *`
- `recurring`: `true`
- `prompt`: the template below, with `<SLUG>` and `<SKILL_SHORT_ID>` (first 8 chars of skill_resource_id) substituted

**Before calling CronCreate**: verify every `<SLUG>` and `<SKILL_SHORT_ID>` placeholder in the template is replaced with the actual values. There are multiple occurrences — check all of them.

```
Check on the <SLUG> loop on Hetzner. This is a 4-check monitoring sequence. Count your prior check reports in conversation history to determine which check this is (1 of 4, 2 of 4, etc.).

Run:

ssh -i "$OPENCLAW_SSH_KEY" "root@$OPENCLAW_HOST" 'docker exec runtime-runtime-1 bash -c "
  if tmux has-session -t "<SLUG>" 2>/dev/null; then echo TMUX:alive; else echo TMUX:dead; fi
  echo "EPOCH:$(cat /root/dispatch/<SKILL_SHORT_ID>/workspace/state.json 2>/dev/null | jq -r '.epoch // "unknown"')"
  LOGFILE=\$(ls -t /root/.claude/projects/-root-dispatch-<SKILL_SHORT_ID>/*.jsonl 2>/dev/null | head -1)
  [ -n \"\$LOGFILE\" ] && tail -5 \"\$LOGFILE\"
"' | python3 -c "
import sys, json
lines = sys.stdin.read().splitlines()
tmux = 'unknown'
epoch = 'unknown'
last_tool = 'none'
for line in lines:
    s = line.strip()
    if s.startswith('TMUX:'): tmux = s.split(':',1)[1]; continue
    if s.startswith('EPOCH:'): epoch = s.split(':',1)[1]; continue
    try:
        m = json.loads(s)
        if m.get('type') != 'assistant': continue
        for c in (m.get('message',{}).get('content',[]) or []):
            if c.get('type') == 'tool_use': last_tool = c['name']
    except (json.JSONDecodeError, KeyError, TypeError): pass
print(f'Epoch {epoch}. Last tool: {last_tool}. Tmux: {tmux}.')
" || echo '[error] SSH command failed — host may be unreachable.'

Report the one-line summary to the user: "Check N of 4 — Epoch X. Last tool: Y. Tmux: alive/dead."

Auto-cancel logic:
- If this is check 4 AND the epoch is higher than what you reported in a previous check AND tmux is alive: cancel this cron with CronDelete and report "Loop healthy after 4 checks — monitoring complete."
- If this is check 4 AND the cancel conditions above are NOT met (epoch stuck, tmux dead, or SSH failed): cancel this cron with CronDelete and report the issue — the loop needs manual intervention.
- If tmux is dead OR the epoch has not advanced since the last check (checks 1–3 only): report the issue and keep monitoring.
- If the SSH command failed (checks 1–3 only): report the error and keep monitoring.
```

Tell the user the cron job ID so they can cancel it early if needed.
