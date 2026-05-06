# auth/src/adapters

Auth adapter implementations. Each adapter maps a different authentication surface to the common `AuthAdapter` / `SessionAdapter` interfaces.

- `types.ts` — `AuthAdapter`, `AuthToken`, `AuthCredentials`, `SessionAdapter`, `AuthSession` interfaces
- `access-code.ts` — `AccessCodeAuthAdapter`: headless email + access-code exchange for Supabase JWT; used in E2E tests and CLI `--access-code` flag
- `browser.ts` — `BrowserAuthAdapter`: wraps Supabase browser session; used by agent-livestream frontend
- `cli.ts` — `CLIAuthAdapter`: launches local HTTP redirect server for OAuth browser flow; also delegates to `AccessCodeAuthAdapter` for headless path
- `supabase.ts` — `createSupabaseClient` and `createAuthenticatedSupabaseClient` factory functions
- `debug-session.ts`, `anonymous-session.ts`, `user-session.ts`, `magic-link-session.ts` — `SessionAdapter` implementations for browser-side auth lifecycle

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
