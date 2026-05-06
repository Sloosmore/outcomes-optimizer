# Codex Compatibility Addendum

You are running on **Codex CLI**, not Claude Code. The following adaptations apply:

## Tool Mapping

| Claude Code Tool | Codex Equivalent |
|------------------|------------------|
| `Skill tool` | `$skill-name` syntax in your message (e.g., "Use $oversight to...") |
| `Task tool` (subagents) | **None** - you do all work directly, no delegation |
| `Read tool` | Shell: `cat`, `head`, `sed -n '1,100p'` |
| `Write tool` | Shell: `cat <<'EOF' > file` or `apply_patch` |
| `Edit tool` | `apply_patch` for targeted changes |
| `Glob tool` | Shell: `rg --files` or `find` |
| `Grep tool` | Shell: `rg "pattern"` |

## Skill Invocation

When the prompt says "Use Skill tool to invoke oversight", instead write in your response:

```
$oversight generate {goal}
```

or

```
$oversight validate --goal workspace/goal.md --outputs workspace/final/
```

Codex will recognize the `$skill-name` syntax and load the skill automatically.

## No Subagents

Codex does not spawn subagents. When the prompt says "delegate to a subagent" or "use Task tool", you must:
1. Do the work yourself directly
2. Execute shell commands to run code, tests, etc.
3. Use `apply_patch` to make file changes

## File Operations

**Reading files:**
```bash
cat workspace/state.json
sed -n '1,50p' workspace/progress.md  # first 50 lines
rg "pattern" workspace/               # search
```

**Writing/editing files:**
```
*** Begin Patch
*** Update File: workspace/state.json
@@ ... @@
-old line
+new line
*** End Patch
```

Or for full file writes:
```bash
cat <<'EOF' > workspace/state.json
{
  "epoch": 1,
  ...
}
EOF
```

## Key Behavioral Differences

1. **Single agent**: You are the only agent. No delegation possible.
2. **Direct execution**: Run commands yourself, don't ask others to run them.
3. **Skills via $syntax**: Replace all Skill tool references with `$skill-name`.
4. **Shell-first**: Prefer shell commands for file operations over any tool syntax.
