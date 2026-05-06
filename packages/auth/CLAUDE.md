# auth

Shared authentication utilities for Supabase JWT management.

## Lint Enforcement

`packages/auth/eslint.rules.js` registers per-package ESLint rules:

Rules scoped to `src/**/*.ts` (excluding `src/services/`):
- **No raw SQL outside services** — `sql\`...\`` tagged template expressions are banned outside `src/services/`. All `auth.users` queries must be centralized in `AuthService` (`src/services/auth-db.ts`) because the auth schema is Supabase-managed and its schema must be accessed through a single, auditable code path.

`src/services/auth-db.ts` is the only approved location for raw SQL in this package.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
