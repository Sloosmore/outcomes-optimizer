#!/bin/sh
# Apply all Supabase migrations in sorted order against the local postgres instance.
# This script runs inside /docker-entrypoint-initdb.d/ on first container start.
set -e

MIGRATIONS_DIR="/migrations"
PSQL="psql -v ON_ERROR_STOP=1 -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-postgres}"

echo "==> Applying migrations from $MIGRATIONS_DIR"

for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  echo "  --> $f"
  $PSQL -f "$f"
done

echo "==> All migrations applied successfully."
