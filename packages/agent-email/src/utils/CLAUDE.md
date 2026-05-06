# agent-email/src/utils

Utility modules for `agent-email`:

- **poll.ts** — `waitForEmail()` (polling loop with timeout, sender/subject filters, seenIds tracking) and `getLatestEmail()` (sort by date descending)
- **extract.ts** — `extractLinks()` (href + plain-text URL extraction from HTML/text) and `extractCode()` (ordered regex patterns for OTP/verification codes, ReDoS-safe length limits)
- **fetch.ts** — `getProxyFetch()` (wraps `globalThis.fetch` with `AbortSignal.timeout`; detects credential-proxy interceptor via `__nativeFetch`)
- **json.ts** — `safeJsonParse()` (structured error on non-JSON responses)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
