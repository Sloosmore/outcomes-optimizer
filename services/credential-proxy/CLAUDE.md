# credential-proxy

HTTP proxy that intercepts outbound API calls and injects credentials from the DB resource graph.

## Lint Enforcement

`services/credential-proxy/eslint.rules.js` registers per-package ESLint rules:

Rules scoped to `src/**/*.ts`:
- **No raw SQL** — `sql\`...\`` tagged template expressions are banned. All credential queries must go through `CredentialResolverService` from `packages/database/src/services/credential-resolver.ts`.
- **No console** — structured logger (`createLogger` from `@skill-networks/logger`) is required everywhere in credential-proxy.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
