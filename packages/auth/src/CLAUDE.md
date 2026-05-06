# auth/src

Core JWT utilities used across all consumers of `@duoidal/auth`.

- `token.ts` — `decodeJwt`, `getSubClaim`, `getExpiresAt`: zero-dependency base64url decode of JWT payloads (no signature verification)
- `index.ts` — public surface: re-exports token utilities and adapter types/classes
- `adapters/` — auth adapter implementations (see `adapters/CLAUDE.md`)

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
