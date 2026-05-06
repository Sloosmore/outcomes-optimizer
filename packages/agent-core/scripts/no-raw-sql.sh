#!/usr/bin/env bash
# Fails if any agent-core source file imports postgres directly or calls getSql()
set -e
VIOLATIONS=$(grep -rn "from 'postgres'\|getSql()" packages/agent-core/src/ --include="*.ts" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "RAW SQL VIOLATIONS FOUND:"
  echo "$VIOLATIONS"
  exit 1
fi
echo "No raw SQL violations found."
exit 0
