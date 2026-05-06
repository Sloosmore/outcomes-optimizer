#!/bin/sh
set -e

LOCKFILE="/workspace/pnpm-lock.yaml"
HASH_FILE="/workspace/node_modules/.install-hash"

if [ ! -f "$LOCKFILE" ]; then
  echo "pnpm-install: pnpm-lock.yaml not found at $LOCKFILE"
  exit 1
fi

HASH=$(sha256sum "$LOCKFILE" | cut -d" " -f1)

if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$HASH" ]; then
  echo "pnpm-install: lockfile unchanged — skipping"
  exit 0
fi

echo "pnpm-install: installing dependencies..."
corepack enable pnpm
cd /workspace && pnpm install --frozen-lockfile

TMP_HASH_FILE="${HASH_FILE}.tmp"
echo "$HASH" > "$TMP_HASH_FILE"
mv "$TMP_HASH_FILE" "$HASH_FILE"
echo "pnpm-install: done"
