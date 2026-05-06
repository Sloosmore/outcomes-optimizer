# credential-proxy/src/store

The credential store layer for the proxy. Defines the `CredentialStore` interface (`interface.ts`) and provides the `DopplerCredentialStore` implementation (`doppler.ts`), which fetches secrets from the Doppler API with an in-memory TTL cache.

## Design Invariants

**Allowlist enforcement is the security gate.** `DopplerCredentialStore` accepts a `ReadonlySet<string>` of allowed env var names at construction time. Any `get()` call for a key not on that set throws immediately, before any network call is made. This prevents a confused-deputy attack where a compromised or malicious resource name causes the proxy to fetch and forward an unrelated secret.

**Cache stampede prevention.** Concurrent `get()` calls deduplicates Doppler API requests via `inflightFetch`. Only one in-flight fetch runs at a time; all concurrent callers share the result.

**Amortized fetching.** A single `get()` call fetches all secrets from Doppler at once and populates the cache for every returned key. Subsequent calls within the TTL window (default 5 minutes) are served from cache with no network access.

**`invalidate()` is the cache reset.** The `/admin/cache/invalidate` endpoint (localhost-only) calls this to force a fresh Doppler fetch. This is the mechanism for propagating secret rotation without restarting the proxy.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
