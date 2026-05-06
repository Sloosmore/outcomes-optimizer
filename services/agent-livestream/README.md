# agent-livestream

Real-time React dashboard that visualises the skill-networks resource graph and shows live agent cursors as they move between resources.

## What it does

- Renders the resource graph (nodes = resources, edges = resource links) using ReactFlow
- Subscribes to `agent_events` via Supabase Realtime to show which resource each running agent process is currently accessing
- Falls back to polling if Realtime is unavailable

## Architecture

```
credential-proxy ──emits──> agent_events (Supabase table)
                                  │
             Realtime / polling ◄─┘
                    │
          agent-livestream (this app)
```

The shared `@skill-networks/agent-events` package provides the `AgentEvent` schema and adapter interfaces used by both the emitter (credential-proxy) and the consumer (this app).

## Environment variables

Create a `.env` file in this directory:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

Both variables are required — the app will throw on startup if either is missing.

## Running locally

```bash
npm install
npm run dev
```

## Building

```bash
npm run build
```
