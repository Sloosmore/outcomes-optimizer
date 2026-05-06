# Database Scripts

Standalone scripts for database operations: RLS policy application and resource seeding.

## Files

- `apply-rls.ts` — Apply row-level security policies (`pnpm run db:rls`)
- `seed-resources.ts` — Seed initial resources into the database

## Migrations

Migrations are SQL files in `supabase/migrations/` applied via:
```bash
pnpm --filter @skill-networks/database run db:migrate
```
In CI, the `db-migrate.yml` workflow applies them automatically on push to main.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
