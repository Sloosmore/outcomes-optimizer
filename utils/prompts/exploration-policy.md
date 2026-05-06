# Exploration-Exploitation Policy (Natural Language Only)

Use this policy if you want to eliminate structured schedules and rely entirely on natural language guidance.

## Policy (98 words)

```
Optimize this system across epochs. You have modest compute
budget—assume 5-15 total epochs. Early epochs: form
diverse hypotheses. Test different approaches in parallel.
Don't commit early. Middle epochs: measure which approach
wins. Final epochs: refine the best one. Stop when new
epochs yield less than 3% improvement—you've hit diminishing
returns. Record every hypothesis. Record every measurement.
Record every decision. Your job: maximize the primary metric.
Measure first. Hypothesize second. Implement third. Trust the
signal, not intuition.
```

## What This Encodes

- **Exploration signal**: "early epochs: form diverse hypotheses"
- **Exploitation signal**: "final epochs: refine the best"
- **Stopping signal**: "less than 3% improvement"
- **Measurement mandate**: "measure first, always"
- **Budget hint**: "5-15 epochs" (adaptive, not fixed)

## What This Loses

- Exact reproducibility (different models may interpret differently)
- Observable transition points (can't measure when exploration → exploitation)
- Problem-specific tuning (works generally, not optimally per problem)
- Hard guarantees (stopping criteria are heuristic, not enforced)

## Comparison to Structured Approach

| Aspect | Natural Language Only | Hybrid (Current) |
|--------|----------------------|------------------|
| **Generality** | High (works across problems) | High (parameterized schedules) |
| **Observability** | Low (can't measure transitions) | High (explicit epoch counts) |
| **Reproducibility** | Medium (model-dependent) | High (deterministic config) |
| **Adaptivity** | High (model adjusts to problem) | Medium (fixed schedule) |
| **Debuggability** | Low (implicit behavior) | High (explicit rules) |
| **Simplicity** | High (no config) | Medium (requires YAML) |

## Recommendation

Use this policy **only if**:
- Your problems are similar (same timescale, metric type)
- You don't need reproducibility across models
- Observability of exploration/exploitation isn't critical

Otherwise, prefer the **hybrid approach**: fixed epoch budgets (config) + rich natural language guidance (prompts).

The bitter lesson favors the hybrid: **general methods (schedules) + adaptive guidance (language)**, not removing all structure.
