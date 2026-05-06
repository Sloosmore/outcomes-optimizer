# BFF Server Principles

## API Contract: IDs not names

**API query params must use UUIDs, never human-readable names.**

`?projectId=<uuid>` ✅  `?project=developer-leverage` ❌

Names are for display only — they change, collide across users, and require an extra DB lookup to resolve. Pass the UUID from the frontend; the BFF uses it directly with no name-resolution step.

The URL segment `/p/:projectId` carries the UUID. `useProjectId()` returns it. All `?projectId=` query params are validated as UUIDs at the route boundary (400 on invalid input). Domain functions (`buildGraph`, `queryProcesses`, `fetchLatestMetrics`) accept `projectId?: string` directly.

This is the Backend-for-Frontend (BFF) — a Hono server that sits between the Vite frontend and Supabase.

## Architecture: pure-manifest app.ts

`app.ts` is a **pure-manifest** (~37 lines). It contains ONLY `app.route()` and `app.use()` calls. Zero inline handlers. Zero business logic. If you find yourself writing a handler in `app.ts`, stop and create a file in `routes/` instead.

```
app.ts               — Pure manifest (~37 lines). ONLY app.route() and app.use() calls. Zero inline handlers.
middleware/jwt.ts    — JWT verification (JWKS + HS256 fallback). Exported as jwtMiddleware.
routes/
  health.ts          — GET /health (unauthenticated)
  token.ts           — POST /token (unauthenticated)
  auth.ts            — POST /auth/validate-code (unauthenticated, BEFORE jwt wall)
  graph.ts           — GET /api/graph
  resources.ts       — GET /api/resources, /api/resource-links, /api/resource-types
  processes.ts       — GET /api/processes, GET /api/process-events/:id, GET /api/processes/:id/epochs/latest, GET /api/processes/:id/epochs
  events.ts          — GET /api/events (SSE)
  chats.ts           — GET/POST /api/chats, GET /api/chats/:id
  messages.ts        — /api/chats/:id/messages
  tools.ts           — /api/tools
  metrics.ts         — GET /api/metrics/latest
  preview.ts         — /preview
```

## Route Registration Order (Security-Critical)

Routes registered **before** `app.use('/api/*', jwtMiddleware)` are **unprotected**.
Routes registered **after** are **protected**.

```
// Unauthenticated — BEFORE the jwt wall
app.route('/health', healthRouter)    ← intentionally unprotected
app.route('/token', tokenRouter)      ← intentionally unprotected
app.route('/auth', authRouter)        ← POST /auth/validate-code MUST be before the jwt wall

// Auth wall
app.use('/api/*', jwtMiddleware)

// Authenticated — AFTER the jwt wall
app.route('/api/graph', graphRouter)
app.route('/api', resourcesRouter)
app.route('/api', processesRouter)
app.route('/api/events', eventsRouter)
app.route('/api/chats', chatsRouter)
app.route('/api/chats', messagesRouter)
app.route('/api/tools', toolsRouter)
app.use('/preview/*', jwtMiddleware)  // /preview is outside /api/* so needs its own guard
app.route('/preview', previewRouter)
app.route('/api/metrics', metricsRouter)
```

**Never add a new `/api/*` route above the `app.use('/api/*', jwtMiddleware)` line.**

`POST /auth/validate-code` MUST remain above the jwt wall — it is called before the user has a token (e.g. invite-code validation during onboarding).

## Rules

- **app.ts is a pure-manifest, not a module.** Every route file exports a `new Hono()` instance. There is no `registerXRoutes(app)` pattern. Adding a route means: create a file in `routes/` and add one `app.route()` line in `app.ts`.
- **Every route file exports a `new Hono()` instance.** The file creates a `const router = new Hono()`, registers handlers on it, and exports it. The handler name must match the domain (e.g. `graphRouter`, `chatsRouter`).
- **Supabase client and apiFetch are injected, not imported.** Adapters (node.ts, cloudflare-worker.ts) construct the Supabase client and pass it to app handlers via context. Adapters receive `apiFetch` via dependency injection — they do not import it directly.
- **Validation at the boundary.** Zod schemas validate inputs in route handlers. Domain modules assume valid inputs.
- **No mutation of external state.** Domain functions may mutate their input arrays (enrichment pattern) but must not write to the database. Writes go through `executeAction(name, input, client)` from `utils/database/actions/execute-action.ts` — never inline `supabase.from('resources').insert(...)` or `supabase.from('resource_links').insert(...)` in a route handler. Each action is backed by a Postgres RPC for atomicity. Actions are registered in the `action_types` DB table. If no action exists for your write, add it to the `action_types` table first.
- **Error handling in handlers, not modules.** Domain modules throw on failure. Route handlers catch and return structured errors.
- **Types live in `server/` domain modules.** API response types are Zod-backed. Shared types that the frontend needs are exported through the contract boundary only.
- **Every API route MUST have a contract.** When adding or modifying an API endpoint, define its request/response schema in `contracts/`. Both the route handler AND the frontend fetch call must reference the same contract type. No inline `r.json() as SomeType` — import the type from the contract. This prevents response shape drift (e.g. returning a raw array when the consumer expects `{events, total}`).
- **Constants live in `server/constants.ts`.** Timeouts, feature flags, model names, port numbers — never inline magic values in route handlers or the voice agent. Import from `constants.ts`.

## pure-manifest

The pattern enforces a clear separation between:
1. Route logic (in `routes/*.ts`)
2. Middleware (in `middleware/*.ts`)
3. Registration (in `app.ts`)

This makes the auth boundary auditable at a glance in app.ts.

## Boundary Rule: server/ and src/ must not cross-import

- `server/` must **never** import from `src/`
- `src/` must **never** import from `server/`

These are separate compilation units. The server runs in Node (or Cloudflare Workers); the frontend runs in the browser. Mixing them creates bundling and runtime errors.

## Auth / JWT

The JWKS discovery URL is: `$SUPABASE_URL/auth/v1/.well-known/jwks.json`

JWT middleware (`middleware/jwt.ts`) supports:
1. JWKS verification (RS256) — production path for Supabase-issued tokens (`aud: authenticated`)
2. HS256 fallback — for dev tokens signed with `JWT_SECRET`

The dev token is stored as `BFF_DEV_TOKEN` in your secrets manager.

**When Doppler is unavailable** (expired token, no access), generate a fresh Supabase JWT directly using env vars already in the container:

```bash
TOKEN=$(curl -s -X POST \
  "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${VITE_SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"email":"<EMAIL>","password":"<PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/graph
```

`$SUPABASE_URL` and `$VITE_SUPABASE_ANON_KEY` are always present in the runtime container env — no Doppler needed.

All `/api/*` routes require a valid `Authorization: Bearer <token>` header. A missing, expired, or malformed token returns `401` — never `500`.

## Integration Tests — Running Without Doppler

Pass env vars directly instead of wrapping in `doppler run`:

```bash
SUPABASE_URL=$SUPABASE_URL \
SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY \
SKILL_NETWORKS_DATABASE_URL=$SKILL_NETWORKS_DATABASE_URL \
RUN_INTEGRATION=true \
npx vitest run --reporter=verbose <test-file>
```

**Run test files sequentially, not concurrently.** Running multiple `RUN_INTEGRATION=true` vitest files in parallel exhausts the Supabase connection pool (remote runners have ~600ms baseline latency to Supabase). Graph queries will time out (>60s). Each test file must be its own Bash command, not a combined `&&` chain kicked off simultaneously.

## apiFetch Pattern

Adapters receive `apiFetch` via dependency injection. Route handlers that need to call upstream services receive `apiFetch` through Hono context (set by the adapter at startup), not via a top-level import. This keeps the server testable and avoids global state.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
