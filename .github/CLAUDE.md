# GitHub Workflows

## Philosophy

Keep workflow YAML minimal: setup → seed (optional) → invoke agent → collect artifacts. All logic goes in the prompt, not in workflow conditionals.

## Usage

### Skill mode (no training set)
```bash
gh workflow run universal-workflow.yml -f prompt="Do something"
```

### Ralph-loop mode (with training set)
```bash
gh workflow run universal-workflow.yml -f training_set="image-to-html-v1"
```

When `training_set` is provided:
1. Seeds `workspace/goal.md` and `workspace/training_data/` from database/Supabase
2. Runs ralph-loop with the goal
3. Commits workspace to a branch
4. Uploads artifacts

## Anti-patterns

```yaml
# BAD: Mode switches and conditionals
- if: inputs.mode == 'a'
- if: inputs.mode == 'b'
- if: inputs.mode == 'c'
```

```yaml
# GOOD: One path, optional seeding
- if: inputs.training_set != ''
  run: seed
- run: agent
```
