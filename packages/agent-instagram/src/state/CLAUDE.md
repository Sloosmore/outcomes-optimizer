# agent-instagram/src/state

Session state persistence for agent-instagram. `session.ts` provides:
- `getStateDir()` — resolves state directory from `AGENT_INSTAGRAM_STATE_DIR` env var or `~/.agent-instagram/`
- `loadSession()` / `saveSession()` / `clearSession()` — read/write/delete the JSON session file
- `isValidState()` — validates that a loaded object has all required `SessionState` fields before trusting it

The session file is written with mode `0o600` (owner-read/write only). The password is never stored — only the access token, business account ID, username, created timestamp, and adapter name.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
