# agent-livestream/scripts

Development and operational scripts for the agent-livestream service:

- `check-cursors.mjs` — Queries the DB and reports cursor positions for all active processes
- `check-physics.mjs` — Validates force-layout physics configuration
- `emit-test-events.mjs` — Emits test events to the realtime event bus for local development
- `seed-projects.ts` — Seeds the DB with test projects and users for local development
- `take-screenshots.sh` — Captures Playwright screenshots of the running UI
- `test-e2e-viewport.ts` — Tests viewport/responsive layout at multiple screen sizes
- `test-realtime-creds.mjs` — Validates realtime credential configuration
- `verify-playwright.ts` — Confirms Playwright and browser binaries are installed and functional

These are development/diagnostic utilities — not production-facing code.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
