# agent-livestream/server/routes

BFF route handlers for the agent-livestream server. Each file registers one or more Hono routes under the `/api/` prefix:

| File | Routes | Description |
|------|--------|-------------|
| `health.ts` | `GET /api/health` | DB, SSH, and LiveKit status probe |
| `graph.ts` | `GET /api/graph` | Resource + link graph query (auth-gated) |
| `processes.ts` | `GET /api/processes`, `GET /api/process-events/:id`, `GET /api/processes/:id/epochs/latest`, `GET /api/processes/:id/epochs` | Process lifecycle operations |
| `chats.ts` | Chat CRUD | Conversation management |
| `messages.ts` | Message CRUD | Chat message persistence |
| `events.ts` | Event stream | SSE event fan-out |
| `metrics.ts` | Metrics query | Process metric history |
| `token.ts` | `GET /api/token` | LiveKit access token generation |
| `auth.ts` | `GET /api/auth/callback` | Magic link redirect handling |
| `resources.ts` | Resource CRUD | Skill resource management |
| `tools.ts` | Tool invocation | MCP tool routing |
| `sandbox.ts` | Sandbox operations | VM provisioning integration |
| `preview.ts` | Preview proxy | Artifact preview routing |
| `org.ts` | Org context | Organization-scoped queries |
| `user.ts` | User profile | User record operations |
| `github.ts` | GitHub webhooks | PR and push event ingestion |
| `dev.ts` | Dev utilities | Local development helpers |
| `voice-tool-ctx.ts` | `POST /api/voice-tool/ctx`, `POST /api/voice-tool/dispatch` | Voice-tool JWT auth (not Supabase JWT); `/ctx` returns sandbox SSH context; `/dispatch` (demo) returns terrain dashboard URL for user's latest process; NOT behind the JWT wall |
| `debug-log.ts` | `POST /api/debug-log` | Sink for LiveKit Cloud worker stdout events; X-Debug-Log-Secret header auth (not Supabase JWT); NOT behind the JWT wall |

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
