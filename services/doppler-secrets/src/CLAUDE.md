# doppler-secrets/src

Implementation of the `SecretsStore` interface for Cloudflare Workers. Fetches secrets from Doppler with a KV fallback and fail-closed behavior.

## Module Map

| File | Role |
|---|---|
| `store.ts` | `createSecretsStore` — primary store factory with TTL cache, KV fallback, and stampede guard |
| `doppler.ts` | `fetchDopplerSecrets` — raw Doppler API client |
| `types.ts` | `SecretsStore` interface, `DopplerUnavailableError`, `SecretNotFoundError` |
| `index.ts` | Public exports including `createStaticStore` (for testing) |

## Key Behaviors

**Three-tier resolution:** (1) in-memory TTL cache, (2) live Doppler API, (3) KV fallback. The store never silently returns empty or undefined — it throws `SecretNotFoundError` for unknown keys and `DopplerUnavailableError` when both Doppler and KV are unreachable.

**Fail-closed:** if Doppler is unreachable and no KV fallback value exists, `createSecretsStore` throws at initialization time rather than returning a store that serves empty values. A worker that boots with a broken secrets store is a deployment error, not a runtime surprise.

**Background refresh:** after the TTL expires, the first `get()` call triggers a background re-fetch. Subsequent calls during the fetch are served from stale cache rather than waiting. This prevents request latency spikes on TTL expiry.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
