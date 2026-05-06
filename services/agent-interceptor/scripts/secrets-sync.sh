#!/bin/bash
# Smart secrets sync: only pushes secrets that changed in Doppler since last sync.
# Each wrangler secret bulk call = 1 Worker redeploy + DO reset, so we skip entirely
# if nothing changed, and only bulk-push the diff if something did.
#
# Usage: scripts/secrets-sync.sh <doppler-project> <doppler-config>
# Checksums stored at: ~/.doppler-sync-<project>-<config>.json

set -e

PROJECT="${1:?DOPPLER_PROJECT required (pass as first arg)}"
CONFIG="${2:?DOPPLER_CONFIG required (pass as second arg)}"
CHECKSUM_FILE="$HOME/.doppler-sync-${PROJECT}-${CONFIG}.json"

TEMP_ALL=$(mktemp /tmp/doppler-all-XXXXX.json)
TEMP_CURRENT=$(mktemp /tmp/doppler-current-XXXXX.json)
TEMP_CHANGED=$(mktemp /tmp/doppler-changed-XXXXX.json)
TEMP_DELETED=$(mktemp /tmp/doppler-deleted-XXXXX.txt)

cleanup() { rm -f "$TEMP_ALL" "$TEMP_CURRENT" "$TEMP_CHANGED" "$TEMP_DELETED"; }
trap cleanup EXIT

echo "Fetching secrets from Doppler (${PROJECT}/${CONFIG})..."
doppler secrets download --project "$PROJECT" --config "$CONFIG" --format json --no-file > "$TEMP_ALL"

# Doppler injects metadata keys into every download — filter them out, then diff.
# TEMP_CURRENT holds the filtered snapshot and is reused by the checksum-update block
# below, so DOPPLER_META only needs to be defined once.
RESULT=$(python3 - <<PYEOF
import json, hashlib

DOPPLER_META = {"DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"}

with open("$TEMP_ALL") as f:
    current = {k: v for k, v in json.load(f).items() if k not in DOPPLER_META}

with open("$TEMP_CURRENT", "w") as f:
    json.dump(current, f)

try:
    with open("$CHECKSUM_FILE") as f:
        stored = json.load(f)
except Exception:
    stored = {}

changed = {}
for key, value in current.items():
    h = hashlib.sha256(str(value).encode()).hexdigest()
    if stored.get(key) != h:
        changed[key] = value

deleted = [key for key in stored if key not in current]

with open("$TEMP_CHANGED", "w") as f:
    json.dump(changed, f)

with open("$TEMP_DELETED", "w") as f:
    f.write("\n".join(deleted))

print(len(changed), len(deleted))
PYEOF
)

CHANGED_COUNT=$(echo "$RESULT" | awk '{print $1}')
DELETED_COUNT=$(echo "$RESULT" | awk '{print $2}')

if [ "$CHANGED_COUNT" -eq 0 ] && [ "$DELETED_COUNT" -eq 0 ]; then
    echo "No secrets changed since last sync — skipping Wrangler update."
    exit 0
fi

if [ "$CHANGED_COUNT" -gt 0 ]; then
    echo "Syncing $CHANGED_COUNT changed secret(s) to Wrangler..."
    npx wrangler secret bulk "$TEMP_CHANGED"
fi

if [ "$DELETED_COUNT" -gt 0 ]; then
    echo "Removing $DELETED_COUNT deleted secret(s) from Wrangler..."
    while IFS= read -r key; do
        if [ -n "$key" ]; then
            npx wrangler secret delete "$key" || echo "WARN: failed to delete '$key' — may already be absent from Wrangler"
        fi
    done < "$TEMP_DELETED"
fi

# Update stored checksums only after wrangler operations complete.
# Reads from TEMP_CURRENT (already filtered) — no need to re-apply DOPPLER_META here.
# Replace entirely (not merge) so deleted keys are pruned from the checksum file.
python3 - <<PYEOF
import json, hashlib

with open("$TEMP_CURRENT") as f:
    current = json.load(f)

stored = {key: hashlib.sha256(str(value).encode()).hexdigest() for key, value in current.items()}

with open("$CHECKSUM_FILE", "w") as f:
    json.dump(stored, f, indent=2)

print("Checksums updated.")
PYEOF

echo "Done — $CHANGED_COUNT changed, $DELETED_COUNT deleted."
