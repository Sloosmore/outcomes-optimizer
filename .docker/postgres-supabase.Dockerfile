FROM postgres:16-alpine

# Auth stubs must run BEFORE migrations (sorted by name, so 00_ prefix ensures first)
COPY .docker/postgres-init/00_auth_stubs.sql /docker-entrypoint-initdb.d/00_auth_stubs.sql

# Migrations are named 20260101...sql etc — sort after 00_ and before 98_
# postgres runs all .sql files in /docker-entrypoint-initdb.d/ in alphabetical order
COPY supabase/migrations/ /docker-entrypoint-initdb.d/

# Supplementary tables not in migrations (create_missing_tables) — run after migrations
COPY .docker/postgres-init/03_create_missing_tables.sql /docker-entrypoint-initdb.d/98_create_missing_tables.sql

# Seed test data — must run AFTER all migrations (provision_user() defined in baseline.sql)
COPY .docker/postgres-init/02_seed_test_data.sql /docker-entrypoint-initdb.d/99_seed_test_data.sql
