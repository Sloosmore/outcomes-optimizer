# agent-instagram/src/adapters/instagrapi

The instagrapi adapter bridges TypeScript to the Python `instagrapi` library for profile write operations. `adapter.ts` spawns `runner.py` as a subprocess, writes a JSON payload to stdin, and parses a JSON result from stdout. Profile reads fall back to the Graph API via `graphGet()`.

Operations:
- `set_bio`, `set_name`, `set_website`, `set_pic` — written via `runner.py`
- `get_profile` — read via `runner.py` (if password available) or Graph API (read-only sessions)

The password is never written to disk — it is passed only through stdin to the child process.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
