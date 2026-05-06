# Database

> **Status:** Implemented (schema + storage + upload tooling)

PostgreSQL schema plus Supabase Storage helpers for traces and public assets.

## Tables

### `skill`
Current state of each skill.

| Column | Type | Key |
|--------|------|-----|
| skill_name | TEXT | PK |
| current_commit_hash | TEXT | |
| description | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `skill_version`
Every change via git commits.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| skill_name | TEXT | FK -> skill |
| commit_hash | TEXT | |
| imports | TEXT[] | dependency array |
| reason | TEXT | from commit JSONL |
| timestamp | TIMESTAMPTZ | |

### `traces`
Execution sessions.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| session_id | TEXT | unique |
| started_at | TIMESTAMPTZ | |
| ended_at | TIMESTAMPTZ | |
| file_path | TEXT | path to full trace |
| cost | NUMERIC | optional |
| duration_ms | NUMERIC | optional |
| analysis_status | TEXT | pending/completed (default: pending) |

### `resources`
Registry of all assets agents operate on. Supports one level of parent–child hierarchy: `app` resources parent identity/credential resources. Experiments reference resources directly via a UUID array.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | TEXT | human-readable label |
| type | TEXT | data, identity, url, credential, config, **app** |
| status | TEXT | active, inactive, banned, expired, error |
| config | JSONB | type-specific payload (platform, handle, authEnvVar, appSecretEnvVar, etc.) |
| notes | TEXT | Free-text guidance for the agent |
| locked_by | TEXT | Workflow/process ID holding exclusive checkout |
| locked_at | TIMESTAMPTZ | When the lock was acquired |
| metadata | JSONB | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| parent_id | UUID | FK → resources(id) ON DELETE SET NULL. Must point to an `app` row (CHECK constraint). Null = root. |
| tags | TEXT[] | Discovery tags. GIN-indexed for `@>` queries via `arrayContains()`. |

**`app` resource config shapes:**

Meta (Instagram):
```json
{ "platform": "meta", "appId": "...", "appIdEnvVar": "INSTAGRAM_APP_ID", "appSecretEnvVar": "INSTAGRAM_APP_SECRET", "tokenTtlDays": 60, "graphApiVersion": "v19.0" }
```

Google (YouTube):
```json
{ "platform": "google", "clientIdEnvVar": "YOUTUBE_CLIENT_ID", "clientSecretEnvVar": "YOUTUBE_CLIENT_SECRET" }
```

**Tags convention:**

| Resource | Tags |
|---|---|
| Instagram accounts | `['instagram', 'social', 'identity']` |
| YouTube accounts | `['youtube', 'social', 'identity']` |
| `meta-app-instagram` | `['instagram', 'meta', 'app']` |
| `google-youtube-app` | `['youtube', 'google', 'app']` |

### `campaigns`
Long-running optimization runs that span many epochs. Each row is a campaign the agent optimizes over time.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | TEXT | unique identifier |
| created_at | TIMESTAMPTZ | |
| started_at | TIMESTAMPTZ | When first epoch ran |
| completed_at | TIMESTAMPTZ | When campaign finished |
| training_resource_id | UUID | FK -> resources(id) (nullable) — formerly training_set_id |
| branch | TEXT | Eval branch created for this campaign |
| resource_ids | UUID[] | References to resources table |
| status | TEXT | pending, active, paused, completed, failed |
| current_epoch | INTEGER | Last completed epoch number |
| metrics | JSONB | Aggregate results across all epochs |
| metrics_schema | JSONB | Expected keys in epoch_results.metrics; null = exploratory mode |
| parent_experiment_id | UUID | FK for forked experiments |
| updated_at | TIMESTAMPTZ | |

### `epoch_results`
Per-epoch execution records within an experiment. One row per epoch.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| experiment_id | UUID | FK -> experiments |
| epoch_number | INTEGER | Unique per experiment |
| workflow_run_id | TEXT | GH Actions or process ID |
| session_id | TEXT | Claude session ID |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| duration_ms | NUMERIC | |
| cost | NUMERIC | |
| status | TEXT | in_progress, completed, failed, crashed |
| metrics | JSONB | Per-epoch measurements (shape defined by experiments.metrics_schema) |
| epoch_debrief | TEXT | Agent's post-epoch reflection: what happened + what was learned |

## Schema Change Rules

- **RLS on every new table and storage bucket** - Any Drizzle migration that creates a new table must append `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and a `service_role_full_access` policy to the same migration file. Any new Supabase storage bucket must have corresponding `storage.objects` policies added to `utils/database/rls.sql`.
- **Drizzle migrations for all DDL** - All schema changes (adding/dropping columns, creating/altering tables, indexes) must go through Drizzle: update `utils/database/schema.ts`, write a numbered SQL migration in `drizzle/`, and add the entry to `drizzle/meta/_journal.json`. Never apply DDL directly to production without a corresponding migration file and schema update.

## Design Decisions

- **Natural keys:** `skill_name` as PK (agent-friendly, no joins)
- **Immutable names:** rename = create new + deprecate old
- **One-level resource hierarchy:** `app` resources (type=`app`) parent identity/credential resources via `parent_id`. Max one level — enforced at the app layer (`resolveParentId` rejects non-`app` parents; PostgreSQL CHECK constraints do not support subqueries so this cannot be a DB constraint). Deleting a parent orphans children gracefully (`ON DELETE SET NULL`). `experiments.resource_ids` stays flat; no implicit parent traversal.
- **Tags for discovery:** `tags text[]` with a GIN index replaces config-field parsing for resource queries. Use `arrayContains(resources.tags, ['instagram'])` to find resources by platform without touching JSONB. Tags on CLI update **replace** the full array (not merged).
- **Progressive disclosure:** Agent resolves resources as needed from DB at runtime, not materialized upfront.
- **Resource-level locking:** `locked_by`/`locked_at` on `resources` (not experiments) — exclusive checkout uses an atomic `UPDATE ... WHERE locked_by IS NULL`.
- **Exploratory metrics:** `experiments.metrics_schema` is nullable. Null = exploratory mode (free-form JSONB). Set from GOAL.md at experiment creation; agent may update at runtime.

## Files

```
utils/database/
├── schema.ts           # Drizzle table definitions
├── client.ts           # PostgreSQL connection
├── resource-helpers.ts # Constants + pure helpers for resources CLI
├── resources.ts        # Resources CLI (add/list/update/update-status)
├── seed-resources.ts   # One-time seed: backfill tags, insert app rows, link parent_id
├── storage.ts          # Supabase Storage helpers (traces + public assets)
├── upload-asset.ts     # CLI for public asset uploads
└── test-connection.ts  # Connection test
```

## Commands

```bash
npm run db:generate  # Generate migration from schema changes
npm run db:migrate   # Apply pending migrations
npm run db:studio    # Open database UI
npm run db:test      # Test connection
npm run upload-asset <file> [folder]  # Upload public assets to Supabase

# Run once after migration 0013 to backfill tags and link parent_id:
doppler run -- npx tsx utils/database/seed-resources.ts
```
