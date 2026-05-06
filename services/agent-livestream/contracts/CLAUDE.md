# contracts/ — Neutral Contract Zone

This directory defines all shared types between `server/` and `src/`. It is a service root — **neither frontend nor backend**.

## Rules (Non-Negotiable)

1. **Zod schemas only.** No runtime logic, no side effects, no classes.
2. **No imports from `../server/` or `../src/`.** Only external packages and zod.
3. **camelCase wire format for new APIs.** New schemas use camelCase field names (e.g. `chatId`, `createdAt`). Exception: `processes.ts` and `metrics.ts` reflect the raw Supabase/DB column names (snake_case) because the server passes DB rows through directly without transformation. Do not add snake_case fields to new schemas.
4. **Workspace package with build step.** `package.json` defines a `build` script (`tsc`) and conditional exports. The `dist/` output is gitignored. Run `pnpm --filter @skill-networks/contracts build` to compile.

## Domain Files

| File | Contents |
|---|---|
| `graph.ts` | ApiResourcesResponse, ApiResourceLinksResponse, ApiGraphResponse, ApiSseEvent, BffAdapter |
| `processes.ts` | ApiProcessSchema, ApiProcessesResponse, ProcessEventSchema |
| `chat.ts` | ChatSummary, ChatDetail, MessageRow (canonical camelCase), TokenResponse |
| `livekit.ts` | ResearchDispatch, ArtifactReady, BackgroundTaskUpdate, WorkerError, WorkerHeartbeat |
| `metrics.ts` | ApiMetricSnapshotSchema, ApiMetricsLatestResponseSchema, ApiMetricsHistoryResponseSchema |
| `sse.ts` | SSEEventSchema, SSEEvent union |
| `index.ts` | Barrel re-export |

## tool_calls Decision

`tool_calls` is a DB-internal field on the `messages` table used for observability. It is **intentionally excluded from the MessageRow wire format**. The `MessageRow` schema in `chat.ts` does not include `toolCalls`. If a consumer needs tool call data, it should use a dedicated endpoint. This decision is documented here to prevent future schemas from re-adding it without explicit consideration.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
