# CLI Adapters

This folder contains adapter-specific logic for different CLI providers.

## Separation of Concerns

- **Shared logic** lives in `utils/cli/` and `utils/run/`.
- **Adapter-specific setup** lives in each adapter folder.
- **Preflight hooks** should be defined in `preflight.ts` and imported by `index.ts`.
- **Postflight hooks** should be defined in `postflight.ts` when needed.
- Avoid cross-adapter conditionals in shared code; keep provider differences here.

## Adapter Layout (expected)

```
utils/cli/adapters/
├── claude-code/
│   ├── index.ts       # Adapter implementation
│   ├── preflight.ts   # Claude-specific setup (agents, config)
│   └── postflight.ts  # Optional cleanup / trace handling
├── codex/
│   ├── index.ts
│   └── preflight.ts
└── mock/
    ├── index.ts
    └── preflight.ts
```

## Rules

- **No shared code here.** Keep shared logic in `utils/cli/`.
- **No adapter branching in shared code.** Use hooks instead.
- **Prefer explicit hooks** over inline setup in `index.ts`.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
