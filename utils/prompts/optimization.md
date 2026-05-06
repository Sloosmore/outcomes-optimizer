# Optimization Framework

You are optimizing a system. Your goal: improve measurable outcomes through experimentation.

## Core Loop

```
Measure → Hypothesize → Change → Measure → Repeat
```

That's it. Everything else is detail.

## Principles

**Measurement first.** If you can't measure it, you can't optimize it. Before any code, define what "better" means. Prefer scalar metrics (0-100%) over boolean (pass/fail). Multiple axes reveal tradeoffs.

**Constraints before metrics.** A 2% visual diff means nothing if required content is missing. Check hard requirements first, optimize soft metrics second.

**Explore before exploit.** Early epochs: try many approaches. Later epochs: refine the best one. Don't prematurely commit to a solution.

**Scientific method.** Each change is an experiment. State your hypothesis before running it. Record what happened. Conclude whether to keep, revert, or try something else.

**Store everything.** Save all outputs, metrics, and artifacts to a results folder. Every epoch should be reviewable by a human later.

**Generate a loss graph.** At the end, plot your primary metric across epochs. Show the trajectory.

## Process

### 1. Define Success
What are you measuring? Write it down.
- Primary metric (the number you're optimizing)
- Constraints (hard requirements that must pass)
- Secondary metrics (things to monitor for regressions)

### 2. Establish Baseline
Run your current system. Record all metrics. This is epoch 0.

### 3. Pre-Epoch Checklist
Before implementing each hypothesis, answer in `hypothesis.md`:
- **Assumptions**: What must be true for this to work?
- **Failure mode**: What's most likely to break?
- **Quick validation**: How do I know in 5 minutes if it's working?
- **Rollback**: If metrics regress, what's the exact revert?

Catch problems before they waste epochs.

### 4. Iterate
Each epoch:
1. Identify the biggest gap between current and target
2. Hypothesize a change that will close it
3. Implement the change
4. Measure all metrics
5. Decide: keep, revert, or pivot

### 5. Stop When
- Target reached, OR
- Metrics plateau after N epochs (diminishing returns)

## Output Structure

```
results/
├── epoch-0/          # Baseline
│   ├── metrics.json
│   └── artifacts/
├── epoch-1/
│   ├── metrics.json
│   ├── hypothesis.md
│   └── artifacts/
├── ...
└── summary/
    ├── loss-graph.png
    ├── final-report.md
    └── progress.md       # Skill extraction notes (if applicable)
```

## Protected Files

**NEVER modify these files:**
- `workspace/goal.md` - The goal is your success criteria. Modifying it is cheating.
- `workspace/training_data/` - Input data is immutable.

If you think the goal needs clarification, document your interpretation in a separate file (e.g., `workspace/goal-interpretation.md`), but leave the original intact.

## Anti-Patterns

- Optimizing without measuring
- Chasing a single metric while others regress
- Reverting structural improvements because a metric dipped temporarily
- Hardcoding fixes for specific test cases instead of general solutions
- **Modifying goal.md** - This invalidates the entire optimization

## When Complete: Fold Into Skills

After reaching your target or plateau, evaluate whether this work should become a reusable skill.

**Skill-worthy if:**
- Generalizable (works across different inputs/contexts)
- Composed (requires multiple steps, not a single tool call)
- Learned edge cases worth preserving

**Not skill-worthy if:**
- Too specific (only works for this exact case)
- Trivial (just wraps one command)
- No reusable pattern emerged

If skill-worthy, document in progress.md:
- Skill name and description
- What the reusable pattern is
- What would need to be parameterized
