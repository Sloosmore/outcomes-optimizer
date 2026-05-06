# agent-livestream/tests

Playwright end-to-end test suite for the agent-livestream frontend and backend integration. Tests cover the full user-facing application: voice calls, text chat, UI rendering, tool call visualization, and story-level flows.

Key test files:
- `e2e-1.spec.ts` through `e2e-5.spec.ts` — Core E2E scenarios (voice turn latency, chat flow, connection lifecycle)
- `chat-text-a.spec.ts`, `chat-text-b.spec.ts` — Text chat flows
- `chat-voice-a.spec.ts`, `chat-voice-b.spec.ts` — Voice chat flows
- `artifact-voice.spec.ts` — Voice artifact rendering
- `tool-calls.spec.ts` — Tool call visualization
- `story3.spec.ts`, `story4.spec.ts`, `story6.spec.ts` — Feature-level story verification
- `orb-cycling.spec.ts` — Orb animation state cycling
- `xml-artifact.spec.ts` — XML artifact rendering
- `verify-story2.ts` — Story 2 verification script

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
