---
name: dispatch
description: >
  Takes an existing goal file (workspace/goal-<slug>.md or workspace/goal.md)
  and dispatches it to a runner. Accepts an optional goal file path argument.
  Uses the duoidal execute command (runner.md). Does NOT interview or generate
  goals — use create-skill.
context: inherit
agent: general-purpose
---

# Dispatch Skill — Goal to Runner

You take a finished goal and ship it to a runner. You do NOT interview, research, or generate goals — that is the `create-skill` skill's job.

**Goal file resolution** (in order):
1. If a goal file path is passed as an argument (e.g., `/dispatch workspace/goal-credential-vault-link.md`), use that path.
2. If the context argument specifies a goal file path, use that.
3. Otherwise, default to `workspace/goal.md` (legacy — create-skill now produces `workspace/goal-<slug>.md`).

Set `GOAL_FILE` to the resolved path. The resolved path must be under `workspace/` — if it is not, tell the user and stop. If the resolved file does not exist, tell the user:

> "No goal found at <path>. Run the create-skill skill first to generate one."

Then stop.

## Pre-Phase: Context Argument

If this skill was invoked with a context argument, read it before doing anything else. Extract values but do NOT set `GOAL_FILE` yet — that happens after context extraction using the priority order above:
- The goal file path (used only if no positional argument was provided — step 2 in the resolution order)
- Run type if specified (local, openclaw, cloud, gha)
- Any overrides (max epochs, specific branch name)

If the run type is already clear, skip the question and go straight to execution.

## Phase 1: Where?

**Default is via `duoidal execute`.** Load `references/runner.md` and read it before proceeding.

## Phase 2: Upload Goal to DB

Upload the goal as a skill resource and link it to the agent or user that runs it:

```bash
GOAL_CONFIG=$(jq -Rs '{content: .}' "$GOAL_FILE")
SLUG=$(npx tsx utils/dispatch/steps/slug.ts --slug "$(head -1 "$GOAL_FILE")")
SKILL_RESOURCE_ID=$(npx duoidal resource add \
  --type skill \
  --name "skill/$SLUG" \
  --config "$GOAL_CONFIG")
if [ -z "$SKILL_RESOURCE_ID" ]; then
  echo "ERROR: Goal upload failed — do not dispatch"
  exit 1
fi
echo "Goal resource ID: $SKILL_RESOURCE_ID"
```

**Link to the agent or user that runs this goal.** Every dispatched goal must be linked via the `runs` link type to an agent or user. This determines where the agent cursor appears on the dashboard graph. Infer the best match from the goal content and the available agents/users:

```bash
npx duoidal search "" --type agent --json
npx duoidal search "" --type user --json
```

Then create the link:

```bash
npx duoidal link "$AGENT_OR_USER_NAME" "skill/$SLUG" --type runs
```

**Selection logic:**
1. If the goal contains an `## Assignment` section with a `Runs:` field (set by create-skill), use that.
2. If the goal clearly serves a specific agent (e.g., infrastructure work → `agent-efficiency`, content work → a content agent), link to that agent.
3. If the context argument specifies an agent or user, use that.
4. If nothing clearly matches, link to the user (the human who dispatched it).
5. If genuinely unclear, lightly ask the user: "Which agent or user should run this?"

Do not skip this step — unlinked goals are invisible on the dashboard. Do NOT use `parent` link type for goal assignment — goals link to agents/users via `runs`. The `parent` type is for skill-to-skill hierarchy only.

If no `runs` link exists at dispatch time, `dispatch.ts` will exit 1. Pass `--unlinked` to bypass this check (a WARNING will be logged):

```bash
npx duoidal execute --skill-resource-id "$SKILL_RESOURCE_ID" --unlinked
```

**Phase 2c: Resolve the user's project ID.** Every dispatched process should be linked to a project. Resolve the project ID from the user who is dispatching:

```bash
# Find the user's project resource (provisioned automatically on signup — one per user)
PROJECT_LOOKUP_ERR=$(mktemp)
PROJECT_ID=$(npx duoidal search "" --type project --json 2>"$PROJECT_LOOKUP_ERR" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
    const p = d.find(r => r.name.startsWith('project:'));
    if (p) process.stdout.write(p.id);
  " 2>>"$PROJECT_LOOKUP_ERR")
if [ -n "$PROJECT_ID" ]; then
  echo "Project ID: $PROJECT_ID"
else
  echo "WARNING: Could not resolve project ID — process will have project_id=NULL" >&2
  [ -s "$PROJECT_LOOKUP_ERR" ] && cat "$PROJECT_LOOKUP_ERR" >&2
fi
rm -f "$PROJECT_LOOKUP_ERR"
```

Pass `PROJECT_ID` to the dispatch command in Phase 3 via `--project-id "$PROJECT_ID"` (only if non-empty).

## Phase 3: Execute

Hand off to the loaded reference's dispatch/execution section. The reference defines:
- How the runner is reached (local worktree, SSH, webhook, GHA)
- What environment is needed
- How to register the run with the tracking system

Execute those steps exactly. Do not improvise.

## Phase 4: Confirm to User

Tell the user where the loop is running and how to observe it:
> "The loop is running. [Location and how to attach or tail logs, per the reference's output.]"

---

## Branch Naming

Branch prefixes follow the run type:
- `feat/<slug>` — all human-initiated run types (`feature`, `cloud`)
- `run/<slug>` — headless (programmatic) runs only

See the Run Types table in `docs/skills/dispatch.mdx` for the full mapping including DB `run_type` values.

## Anti-Patterns

- **Never interview.** This skill dispatches. The create-skill skill interviews.
- **Never run without a goal.** If the resolved goal file is missing, stop and tell the user.
- **Never run the loop in the current directory.** Isolation is always required — the reference defines where.
- **Never skip the goal upload.** The goal must be in the DB before dispatching.
- **Never improvise execution.** Follow the loaded reference exactly.

## Verification

**What to check:** After dispatch, the goal file is uploaded as a skill resource in the DB and a process record exists for the dispatched run. These are the two observable side effects that confirm dispatch succeeded.

**How to run:**
```bash
# After dispatching a goal, verify the resource was created:
SLUG=$(npx tsx utils/dispatch/steps/slug.ts --slug "$(head -1 workspace/goal.md)")
npx duoidal search "skill/$SLUG" --type skill --json
# Output must contain the resource with "name": "skill/<slug>" — not an empty array

# Verify the process was created and linked:
npx duoidal process list --json | jq '.[] | select(.resource_name == "skill/<slug>")'
# Must return at least one process record with a non-null ID
```

**What failure mode it catches:** A goal upload that silently fails (empty `SKILL_RESOURCE_ID`) would allow dispatch to proceed without the goal being recorded in the DB. The resource search catches this: if the upload failed, `agent-core search` returns an empty result rather than the expected resource. Checking only that the SSH command or tmux session launched would miss a scenario where the runner starts but cannot access the goal because it was never uploaded.

**Why it cannot be gamed:** The `agent-core search` call queries the live database. A process or resource that exists only in the local shell environment (e.g., an env var set to a fake ID) will not appear in the DB query results. The test requires a real round-trip through the `agent-core resource add` pipeline.

## See Also

- **create-skill** — Conducts the goal interview and writes `workspace/goal-<slug>.md`. Use this before dispatch.
- **oversight** — Blind validator for agent outputs. Called during the interview phase and by the PR review workflow.

These three skills form the core planning-to-execution pipeline: `create-skill` → `dispatch` → `oversight`.
