# credential-proxy/src

Core implementation of the HTTP credential-injection proxy. The entry point (`index.ts`) wires together the `DopplerCredentialStore`, the event emitter, and the HTTP server. The handler (`handler.ts`) processes proxy requests. The router (`router.ts`) resolves credentials from the DB resource graph. The store layer (`store/`) fetches secrets from Doppler with an in-memory cache.

## Module Map

| File | Role |
|---|---|
| `index.ts` | Composition root — boots the HTTP server, wires store and emitter |
| `handler.ts` | Request handler — SSRF guard, credential injection, response forwarding |
| `router.ts` | Credential resolution pipeline — DB lookup, allowlist check, OAuth exchange |
| `db.ts` | DB queries for resource/credential resolution |
| `config.ts` | Environment variable names and defaults |
| `native-fetch.ts` | Returns the unpatched Node `fetch` to avoid interceptor recursion |
| `interceptor.ts` | Client-side fetch patch that routes outbound calls through the proxy |
| `store/` | `DopplerCredentialStore` and `CredentialStore` interface |

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
