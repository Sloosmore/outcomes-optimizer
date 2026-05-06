# credential-proxy/scripts

Test utilities for verifying end-to-end behavior of the credential proxy's event emission path.

## Contents

- `test-emit.mjs` — Standalone script that exercises the `SupabaseEventEmitterAdapter` directly: it writes an event to the `agent_events` table using a real Supabase connection, then queries the row back by `process_id` to confirm the write succeeded.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
