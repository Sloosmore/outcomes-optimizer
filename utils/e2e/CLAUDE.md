# Utils E2E

One-off migration verification and E2E setup scripts. These are not a test framework — they are standalone `.mjs` scripts that run directly against the live database to verify specific migration correctness.

Current scripts:
- `verify-migration.mjs` — verifies the `auth_user_id` column migration on `resources`
- `verify-rls.mjs` — verifies RLS policies are applied correctly
- `apply-migration-0052.mjs` — one-time migration application script

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
