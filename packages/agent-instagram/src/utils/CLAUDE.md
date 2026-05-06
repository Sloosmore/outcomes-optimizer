# agent-instagram/src/utils

Shared utilities for agent-instagram:
- `fetch.ts` — `getProxyFetch()`: wraps native fetch with proxy support (`HTTPS_PROXY`/`HTTP_PROXY` env vars via undici `ProxyAgent`) and a configurable AbortSignal timeout (default 30s)
- `json.ts` — `safeJsonParse()`: reads a `Response` body as text, enforces a configurable size limit (`MAX_RESPONSE_SIZE`), and parses JSON with a meaningful error on failure
- `output.ts` — `printOutput()`: formats data as JSON (`--json` flag) or human-readable key-value pairs; `exitWithError()`: prints to stderr and exits non-zero

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
