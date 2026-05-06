# outcomes-optimizer

A framework for training agent capabilities through neural network-inspired learning loops.

Released under the [MIT License](./LICENSE).

## Overview

This project explores applying neural network training principles to agent skill development, enabling agents to learn and improve through execution experience.

## Project Structure

### Core Folders

- **`skills/`** - Version controlled skills that the agent evolves over time. These are the trainable capabilities that improve through execution experience.

- **`utils/`** - The backbone of the agent. Contains procedures and utilities that prevent agent degradation over time by encoding specific behavioral constraints and guardrails.

- **`workspace/`** - Ephemeral workspace for agent execution. During pre-training or post-training runs, all new files are created here. This folder is not version controlled and does not persist between runs. When workspace artifacts should be incorporated into skills, a rigorous promotion procedure is required to prevent model collapse.

## Operational Modes

### Development Mode
Building and maintaining the system infrastructure (utils, specs, docs).

### Skill Execution (Pre-training)
**The core mode.** Execute skills to complete real-world tasks, providing actual value. When errors occur (missing dependencies, type errors, validation failures), reflect on what broke, update the skill, commit, and continue. Success means passing the boolean eval: right steps, correct order, deliverables produced (if applicable).

Execution both validates capability (can it do the task?) and provides value (doing the task).

### Skill Refinement (Post-training)
**The feedback loop.** Analyze execution traces and metrics to optimize skills that work for greater economic value. Identify patterns across many executions: which skills correlate with better outcomes? Update skills based on real-world performance data (user satisfaction, conversion rates, quality scores).

After each refinement, run execution to validate that optimization didn't break the skill's ability to complete its steps. Execution acts as a linter, keeping refinement in check and preventing regressions.

Refinement makes execution provide more value, but execution is where value is created.

---

## Conceptual Foundation: When Agents Learn

**Date:** Jan 16, 2026

Agents fail. Often. A prompt doesn't quite work, an output format breaks, the logic hits an edge case. Today, when this happens, someone has to notice, diagnose the problem, update the prompt, and redeploy. Rarely do agents learn, it just waits for humans to fix it.

At the same time, every AI enthusiast to researcher knows how neural networks learn: forward pass, compute loss, backpropagate gradients, update weights, repeat. The loop, this automatic self-improvement from error signals, is what made deep learning work. But we don't apply it to agent capabilities.

This project explores what happens when we do.

### The Current Landscape: Memory Without Learning

The field has made progress on agent memory. Context engineering optimizes what enters the context window. Context graphs build systems of record for decisions. RAG systems retrieve relevant past interactions. Recent work like SCOPE shows agents can improve prompts automatically, jumping from 14% to 39% success rates.

But these approaches optimize memory, not capability. They improve what the agent remembers, what it retrieves, what context it uses. The agent itself, the underlying skill at performing tasks, remains static. It's like giving someone a better notebook without teaching them to write better.

What if we treated agent capabilities like neural network weights, as parameters that update based on execution experience?

### The Analogy: Skills as Trainable Weights

Consider the parallel:

A neural network has weights that shape its behavior. An agent has skill files that shape its behavior.

A neural network runs a forward pass to produce outputs. An agent executes a set of skill files to produce outputs.

A neural network measures error with a loss function. An agent can evaluate whether execution succeeded or failed.

A neural network backpropagates to compute weight updates. An agent could reflect on its execution trace to identify what went wrong in skill chain.

A neural network updates weights and commits them to a checkpoint. An agent could update skills and commit them to version control.

Both systems could optimize parameterized functions through error-driven learning.

### Two Training Loops: Capability and Quality

Neural networks distinguish between pre-training and fine-tuning. We can make a similar distinction for agents:

#### Pre-training: Can it do the task at all?

This is online, in-run learning. The agent executes, hits an error, reflects on what broke, updates the skill, and continues. The evaluation is immediate and synchronous: Was an executable malformed? Did validation fail? Was the prompting factually incorrect or outdated?

The learning signal is technical: exception traces, missing dependencies, type errors, failed assertions. The goal is basic capability, making the agent robust enough to complete execution without human intervention.

Any job decomposes into skill files. Each skill can import other skills, forming a dependency graph. The complexity of the job determines the depth of this graph.

Take customer care as an example. The top-level skill might be handle-support-ticket, which imports three skills: classify-issue-type, retrieve-relevant-docs, and draft-response. Each of those imports more specialized skills, classify-issue-type imports parse-user-message and match-to-categories, while draft-response imports select-tone and format-reply. A relatively simple job, maybe five skills deep.

A complex workflow might be ten or fifteen skills deep with extensive branching. The agent loads one skill, which triggers loading its imports, which trigger their imports, walking the graph until all dependencies resolve. The graph grows as capability requirements grow.

The agent doesn't need to master the entire graph at once. it learns incrementally. When parse-user-message fails because it can't extract structured data from informal language, the agent reflects on the trace, updates that one skill file, commits the change. The next execution loads the improved version. Capability accumulates through repeated execution and targeted fixes.

Pre-training optimizes this graph for basic functionality: Can each skill execute without error? Are imports resolved correctly? Do outputs satisfy structural requirements? These questions get answered during execution.

#### Post-training: Can it do the task well?

This is batch, offline learning. The agent executes many times, and later, hours, days, weeks, real-world metrics flow back. The evaluation is delayed and asynchronous: engagement rates, conversion rates, quality scores, economic outcomes.

The learning signal is empirical: platform analytics, business results, user feedback, comparative performance. The goal is quality optimization, making the agent actually good at the objective it's trying to achieve.

Return to the customer care example. Pre-training ensured handle-support-ticket executes without crashing. Post-training asks: Do customers mark the response as helpful? Do they reply with follow-up questions, or is the issue resolved? Does the ticket get escalated to humans, or does the agent's response close it?

These metrics arrive asynchronously. A ticket gets handled on Monday. The customer response comes Tuesday. The escalation decision happens Wednesday. A week later, enough tickets have accumulated to identify patterns: the formal-tone skill correlates with lower satisfaction scores, while conversational-tone performs better. Or retrieve-relevant-docs successfully pulls documentation, but the docs themselves are wrong, the skill works, but the underlying knowledge base needs updating.

The agent reflects on aggregated traces, identifies which skills in the dependency graph correlate with poor outcomes, proposes updates, commits changes. Unlike pre-training's immediate error-fix loop, post-training operates on statistical signal across many executions. It's not "this execution failed," it's "this skill underperforms on this metric over the last hundred executions."

Both loops update the same skills, but they optimize for different things. Pre-training gets you to "it works." Post-training gets you to "it works well.

### The Reflection Mechanism: Automated Backpropagation

The critical piece is reflection, the agent analyzing its own execution trace to diagnose failures.

When a neural network backpropagates, it computes gradients by tracing how each parameter contributed to the final error. When an agent reflects, it traces how each part of its workflow contributed to the failure.

The agent sees: function calls, inputs, outputs, exceptions, validation results. It identifies: which skill failed, why it failed, what needs to change. It generates: a proposed update to the skill content or dependency graph. It validates: does this fix pass basic checks? It commits: atomic update with rollback capability.

This is backpropagation for agents. Not gradient descent, but error-driven iterative improvement with version control as the parameter store.

### Co-optimization: Architecture Search for Skills

Neural networks can optimize both weights and architecture. Skills can too, but with a crucial difference.

In a neural network, you define the architecture upfront. The number of layers, neurons per layer, connection patterns, these are fixed before training begins. Neural architecture search can explore variations, but it's rearranging predetermined building blocks. You can't spontaneously add a new type of neuron halfway through training.

Skills have no such constraint. The agent can create new skill files during execution.

An agent discovers it needs a validation function that doesn't exist. It writes a new skill file, adds it as an import to the parent skill. The dependency graph evolves, a new neuron appears in the network.

An agent discovers a particular sub-skill is hurting quality metrics. It removes the import, writes a different skill, adds that instead. The graph structure optimizes toward the objective.

This creates a recursive feedback loop: the agent defines the skills (weights), and the skills define the agent (capabilities). Each skill is a neuron. Each import is a connection. But unlike neural networks, the agent can add neurons on demand. The architecture isn't predefined, it emerges from execution requirements.

This co-optimization means the system learns not just how to do things better, but which things to do at all. The capability graph itself becomes trainable, unconstrained by initial design decisions. The system can grow arbitrarily complex or simplify toward efficiency, driven entirely by performance signals.

### Version Control as Knowledge Infrastructure

Git provides the natural infrastructure for this:

Each skill update is a commit, atomic, reversible, traceable.

Bad updates can be reverted when metrics degrade.

Branches enable experimentation without risking production.

History tracks which changes improved performance.

Multiple agents can share skill improvements across deployments.

Version control isn't just storage, it's the training checkpoint system, the experiment tracker, and the knowledge distribution mechanism all at once.

### What This Enables

With these two loops running, agents can:

Automatically fix capability failures. No human in the loop when a skill breaks on an edge case.

Optimize for real-world metrics. Skills evolve toward actual business objectives, not proxy measures.

Share improvements across agents. One agent's learning propagates to others using the same skills.

Maintain stable deployments. Version control enables rollback and A/B testing.

Compound capability over time. Each execution potentially improves the next one.

The system accumulates capability the way neural networks accumulate representational power through training.

### Open Questions

Convergence: Under what conditions do skills stabilize at optimal performance?

Catastrophic forgetting: How do we prevent regression when optimizing for new objectives?

Safety constraints: How do we prevent harmful mutations during automated updates?

Multi-agent learning: Can improvements transfer across different task domains?

Evaluation design: What makes an evaluation signal useful for learning vs. just measurement?

These are research questions, not settled science. But the framework is clear enough to explore.

### Why This Matters Now

Agents are moving from demos to production. They're handling real workflows, real users, real business logic. When they fail in production, manual updates don't scale.

If agents are going to be reliable enough for deployment, they need to learn from deployment experience. Not through human-curated training sets, through actual execution in the real world.

Neural networks learned this lesson: self-supervised learning on real data beats hand-crafted features. Agents will learn the same lesson: self-supervised learning from execution traces beats manual prompt engineering.

The infrastructure is already here, language models that can reflect, version control that can track changes, evaluation systems that can measure outcomes. We just need to close the loop.

---

*This is a conceptual framework and research direction. Specifications and experiments are ongoing work.*
