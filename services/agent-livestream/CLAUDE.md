# agent-livestream — Frontend Principles

These rules are non-negotiable. The linter enforces what it can. The rest is enforced here.

---

## LLM topology — dual-path split

Two separate LLM paths run in this service and they MUST stay independently configurable.

- **Orchestrator** (voice-agent.ts, local-llm-stream.ts): selects tools, drafts replies. Reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`. Production target: OpenAI direct via the local credential proxy.
- **Sandbox subagent** (research.mjs via claude-agent-sdk, launched per-turn by the `claude_code` tool): does the actual rendering work inside the sandbox VM. Reads `SANDBOX_ANTHROPIC_BASE_URL`, `SANDBOX_ANTHROPIC_API_KEY`, `SANDBOX_RESEARCH_MODEL`. Production target: a self-hosted CLIProxyAPI gateway fronting an external coding model.

Never collapse these into one set of env vars — the two paths target different backends and rotating one must not silently rotate the other.

---

## File size

**No code file over 250 lines.** Enforced by ESLint `max-lines`.

If you're approaching the limit, the component is doing too much. Split it — extract a sub-component, a custom hook, or a utility. A focused file is easier to test, review, and reason about.

---

## State buckets

There are exactly three places state lives. Pick the right bucket — never promote state to a higher bucket than necessary.

| Bucket | Tool | Survives refresh? | Shareable? |
|---|---|---|---|
| Server state | React Query | — | — |
| URL state | search params | Yes | Yes |
| Local UI state | useState | No | No |

- Filter selections, active tabs, sort order → URL state
- Loading/error/data → React Query
- Dropdown open, hover → useState

---

## Naming — state setters must use the `set` prefix

Always name state setters `setFoo` for the corresponding `foo` state. The ESLint rule that catches setState-in-effect matches the pattern `^set[A-Z]`. A renamed setter like `update` or `dispatch` bypasses the rule silently.

```tsx
const [count, setCount] = useState(0) // ✅ matches the lint rule
const [count, update] = useState(0)   // ❌ renamed — linter is blind to this
```

---

## No state in useEffect

**Never call a state setter inside `useEffect`.** Enforced by ESLint `no-restricted-syntax`.

`useEffect` has one job: sync with an external system (DOM API, subscription, timer, external store). It is not a lifecycle hook, not a watcher, not a place to derive state.

```tsx
// ❌ wrong — one render lag, hidden dependency chain
useEffect(() => {
  setFiltered(items.filter(predicate))
}, [items, predicate])

// ✅ right — computed during render, always in sync
const filtered = useMemo(() => items.filter(predicate), [items, predicate])
```

The only valid exception: syncing into an *external* system's own store (e.g. `setNodes` into ReactFlow's internal Zustand). That is not React state.

---

## Tokens — two layers, components touch only semantic tokens

```
@theme { --radius-sm: ... }          ← primitives (raw values)
@theme inline { --color-border: ... } ← semantic tokens (reference primitives)
```

Components only ever use semantic tokens (`border`, `background`, `muted-foreground`). Never hardcode raw values (`oklch(...)`, `#fff`, `16px`) in component code.

---

## Variants — CVA is the single source of truth

When a component has visual variants, define them with CVA. TypeScript types and runtime classes come from the same definition — no parallel `type Variant = 'default' | 'outline'` declarations.

```tsx
const button = cva('base-classes', {
  variants: {
    variant: { default: '...', outline: '...' },
  },
})

// Type is derived, not duplicated
type ButtonProps = VariantProps<typeof button>
```

---

## ReactFlow state — Zustand, not React state

Node positions, selection state, and viewport live in ReactFlow's internal Zustand store. Do not mirror them into React state (`useState`). Doing so causes a re-render cascade on every physics tick.

Use `useReactFlow()`, `useNodesState()`, and `useStore()` to read and write ReactFlow state directly.

---

## Styling — Tailwind + CSS variables only

**No inline `style={{}}` props.** Enforced by ESLint `no-restricted-syntax`.

Inline styles bypass the token system, can't respond to dark mode, and create a parallel styling layer that fights Tailwind. Use utility classes instead.

```tsx
// ❌ wrong
<div style={{ color: '#6b7280', fontSize: 14 }}>

// ✅ right
<div className="text-muted-foreground text-sm">
```

Two valid exceptions:

1. **Library position overrides** — ReactFlow's `Handle` applies transform via its own CSS custom property system. Tailwind `!important` conflicts at the `transform` property level and loses. Inline styles are the only reliable override. See `resource-node.tsx`.

2. **Truly dynamic values** — a value computed at runtime with no static Tailwind equivalent. Pass only the CSS variable, not a style value:

```tsx
// Acceptable — runtime value with no static equivalent
<div style={{ '--progress': `${pct}%` } as React.CSSProperties}>
```

**No arbitrary Tailwind values.** Don't use `text-[14px]`, `bg-[#fff]`, `w-[237px]`. If a value isn't in the token system, add it to the token system. Hardcoded values in class strings are inline styles with extra steps.

**No raw color/size primitives in components.** Use semantic tokens (`text-muted-foreground`, `bg-card`, `border-input`), not primitive ones (`text-zinc-500`, `bg-white`). Semantic tokens respond to dark mode automatically.

---

## Component ownership

A component owns its own interior. It does not own its position in the layout.

**Parent positions, child renders.**

The parent decides where a component lives (margin, position, flex/grid placement). The component decides what it looks like inside. A reusable component should have zero margin or positioning on its outermost element.

```tsx
// ❌ wrong — ResourceNode owns its own spacing in the graph
<div className="mt-4 ml-8">...</div>

// ✅ right — ResourceGraph decides where ResourceNode lives
<ResourceNode />              // component has no outer margin
// parent wraps: <div className="mt-4 ml-8"><ResourceNode /></div>
```

**Never reach into a child to style it.**

If you find yourself writing `.my-parent .child-component button { ... }`, the design is wrong. Either the child exposes a `className` prop, or the styling belongs inside the child.

**`className` is the escape hatch.**

Reusable components accept an optional `className?: string` prop and pass it to their outermost element via `cn()`. This is the only approved way for a parent to customize a child's appearance.

Pass the consumer's `className` **last** in `cn()` so it overrides the component's defaults (this is how `tailwind-merge` resolves conflicts):

```tsx
function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-lg border bg-card', className)}>{children}</div>
  //                                                      ^^^^^^^^^ consumer wins
}
```

**Props surface behavior, not implementation.**

Props describe what a component should do (`variant="destructive"`, `isLoading`, `onSelect`), not how it should look (`color="red"`, `fontSize={14}`). Visual decisions belong to the component and its CVA variants, not to callers.

---

## Suppressing lint rules — every disable needs a justification

Every `eslint-disable` comment must explain why the rule does not apply. A bare disable is noise — it teaches nothing and can mask real bugs added later.

```tsx
// ❌ bare disable — why?
// eslint-disable-next-line react-hooks/exhaustive-deps

// ✅ justified — now a reviewer can confirm the claim
// resourceKey is a stable surrogate for resources — re-running when IDs change is intentional
// eslint-disable-next-line react-hooks/exhaustive-deps
```

Same applies to `tokens-ok` comments: the comment on the same line is the justification.

---

## Constants

**Constants live in `src/constants.ts`.** Feature flags, timeouts, API endpoints, model names — never hardcode values inline in components or hooks. Import from `constants.ts`. This enables toggling features independently during testing without changing business logic.

---

## Logging — use `createLogger`, never `console.log`

**No `console.log`, `console.warn`, or `console.error` in committed code.** Use the structured logger from `@skill-networks/logger` in server code and `src/` code alike.

```ts
// ❌ wrong — no structure, no level, no namespace, invisible in log aggregation
console.log('[auth] session check:', session)

// ✅ right — namespaced, leveled, structured
import { createLogger } from '@skill-networks/logger'
const logger = createLogger('agent-livestream:auth')
logger.info('Session check', { hasSession: !!session })
```

The logger writes to stdout (same as `console.log`) but with consistent formatting, log levels, and namespace filtering. Debug logging that you want silenced in production uses `logger.debug` — it is suppressed unless the `DEBUG` env var matches the namespace.

---

## Running the linter

```bash
npm run lint
```

All rules are errors. There is no warning tier — a warning that nobody fixes is noise.

---

## Auth & BFF Debugging

### Get a fresh JWT token

```bash
# Requires VITE_SUPABASE_ANON_KEY and SUPABASE_URL from Doppler
curl -s -X POST \
  "$(doppler secrets get SUPABASE_URL --project <your-project> --config <your-config> --plain)/auth/v1/token?grant_type=password" \
  -H "apikey: $(doppler secrets get VITE_SUPABASE_ANON_KEY --project <your-project> --config <your-config> --plain)" \
  -H "Content-Type: application/json" \
  -d '{"email":"<EMAIL>","password":"<PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
# Then store it: doppler secrets set BFF_DEV_TOKEN=<token> --project <your-project> --config <your-config>
```

### Test a BFF route with auth

```bash
TOKEN=$(doppler secrets get BFF_DEV_TOKEN --project <your-project> --config <your-config> --plain)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/graph
```

### Decode a JWT to check claims

```bash
TOKEN=$(doppler secrets get BFF_DEV_TOKEN --project <your-project> --config <your-config> --plain)
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

### Check if JWKS is reachable

```bash
curl -s "$(doppler secrets get SUPABASE_URL --project <your-project> --config <your-config> --plain)/auth/v1/.well-known/jwks.json" | python3 -m json.tool
```

### Common failures

- **401** — Token expired or missing. Refresh with signInWithPassword above and update BFF_DEV_TOKEN in Doppler.
- **Boot crash** — No JWKS reachable and SUPABASE_JWT_SECRET is empty. Set SUPABASE_JWT_SECRET in Doppler or ensure SUPABASE_URL is correct.
- **403** — Valid token but RLS policy blocked the query. Check Supabase RLS policies for the table being queried.

---

## API Calls — always use apiFetch

**Never use bare `fetch('/api/...')` from `src/`.** Always import and use `apiFetch` from `lib/api-fetch.ts`.

```ts
import { apiFetch } from '@/lib/api-fetch'

// ✅ correct — browser sends @supabase/ssr auth cookie automatically
const res = await apiFetch('/api/graph')

// ❌ wrong — bypasses the apiFetch abstraction layer
const res = await fetch('/api/graph')
```

Auth is handled via `Authorization: Bearer <token>` headers injected by `apiFetch`. The Supabase client is created with `createClient` (from `@supabase/supabase-js`) using `flowType: 'implicit'` and `detectSessionInUrl: true` to support magic link hash fragment detection. The client is instantiated in `src/lib/supabase-client.ts` and imported by both `config.ts` and `lib/api-fetch.ts`. On every `apiFetch` call, the current session is read from the Supabase client (in-memory, no network call) and attached as a Bearer token. Do not use bare `fetch('/api/...')` — the BFF will return 401 with no auth headers.

**Adapters receive fetch via DI constructor, not direct import.** If a class in `src/adapters/` needs to make API calls, accept a `fetch` parameter in its constructor and call `this.fetch(...)`. The caller (e.g. `config.ts`) passes `apiFetch`. This pattern keeps adapters testable without mocking global state.

```ts
// ✅ adapter pattern
export class HttpGraphDataAdapter {
  constructor(private readonly fetch: (url: string, init?: RequestInit) => Promise<Response>) {}
  async getResources() { return this.fetch('/api/resources') }
}

// in config.ts
import { apiFetch } from './lib/api-fetch'
export const graphAdapter = new HttpGraphDataAdapter(apiFetch)
```

---

## Dev Debug Routes

These routes exist only in development (`NODE_ENV !== 'production'`). They are documented here but must NOT be added to Vercel rewrites (no `/dev/*` rewrite — they are local-only by design, with `NODE_ENV` as the second guard).

### Server: `GET /dev/auth-state`

Returns the JWT claims from the Authorization header. Useful for verifying the token the browser is sending.

```bash
TOKEN=$(doppler secrets get BFF_DEV_TOKEN --project <your-project> --config <your-config> --plain)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/dev/auth-state
# Returns: { "sub": "...", "email": "...", "exp": 1234567890, ... }
```

- Requires `Authorization: Bearer <token>` — returns 401 without it
- Always returns 404 in production (`NODE_ENV=production`)
- Does not require a fully verified JWT — useful for debugging expired tokens too

### Frontend: `/dev`

A DevAuthPanel at `http://localhost:5173/dev` showing the current auth session (email, expiry). Accessible in development only — returns 404 in production builds.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
