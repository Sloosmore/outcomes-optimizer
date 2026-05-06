# Agent Interceptor — Architecture Principles

## Natural Language First

This service is a **pure router**. It has no opinion about what tasks mean, how they should run, or what fields they contain. That is the agent's job.

**The only structured fields this service parses are:**

- `id` — UUID, for idempotency and session keying
- `type` — event type string, for logging
- `timestamp` — ISO-8601, for logging
- `data.target` — `"sub"` or `"main"`, for routing
- `data.resource` — resource name string, for proxy resolution (routing infrastructure, not task semantics)

That's it. Everything else in `data.message` is a **natural language contract** that passes through untouched.

## What This Means in Practice

Do not parse task semantics here. If you find yourself inspecting fields like `run_type`, `skill_resource_id`, or similar task-level fields — stop. That logic belongs in the skill or agent reasoning, not in this service.

## Why

The moment custom logic enters the interceptor, the contract hardens into code. Fields become load-bearing. Changing them requires a deploy. The whole point of NL contracts is that they're flexible — the agent figures it out from the skill reference, and the skill reference can change without touching this service.

## The Contract Shape

Callers POST a natural language message to `data.message`. Example:

```
skill_resource_id: abc-123-uuid
run_type: openclaw
skill_ref: skills/dispatch/references/headless.md
task: Fetch the goal from the resource store and execute the headless dispatch process.
```

This is human-readable, agent-parseable, and version-free. The receiving agent reads the `skill_ref`, follows it, and the contract evolves through the reference — not through code changes here.

## Routing: The Exceptions

`data.target: "sub" | "main"` is structured because OpenClaw requires it — it drives which gateway endpoint and session key format to use. This is **OpenClaw's architectural requirement**, not our abstraction. We implement it because we have to, not because we designed it.

`data.resource` is structured for the same reason: it determines which outbound proxy to use when forwarding to the gateway. This is infrastructure plumbing — it routes *how* traffic flows, not *what* the task means. Like `data.target`, it is a routing concern, not task semantics.

Our single abstraction is natural language. Adapter code exists to satisfy external interfaces. We do not invent our own semantics on top of them.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
