#!/bin/bash
# deploy.sh — deploy runtime to Hetzner
# Usage: ./deploy.sh [--adapter <name>] [host]
# Example: ./deploy.sh --adapter openclaw root@1.2.3.4
#
# Adapters: openclaw, (none — cron + wake only)
# Adding a new adapter: create services/runtime/<name>/ with Dockerfile + docker-compose.yml

set -eo pipefail

ADAPTER=""
HOST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --adapter) ADAPTER="$2"; shift 2 ;;
    *) HOST="$1"; shift ;;
  esac
done

HOST="${HOST:-${DEPLOY_HOST:?'Set DEPLOY_HOST or pass host as argument'}}"
if [[ ! "$HOST" =~ ^[a-zA-Z0-9._@:-]+$ ]]; then
  echo "Error: HOST contains invalid characters: $HOST" >&2; exit 1
fi

if [[ -n "$ADAPTER" ]]; then
  if [[ ! "$ADAPTER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: ADAPTER contains invalid characters: $ADAPTER" >&2; exit 1
  fi
  if [[ ! -d "$ADAPTER" ]]; then
    echo "Error: Adapter directory not found: $ADAPTER" >&2; exit 1
  fi
fi

DEPLOY_DIR="/opt/runtime"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/<your-ssh-key>}"
if [[ ! -f "$SSH_KEY" ]]; then
  echo "Error: SSH key not found: $SSH_KEY" >&2; exit 1
fi
SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new)

echo "=== Deploying runtime${ADAPTER:+ (adapter: $ADAPTER)} to ${HOST} ==="

# Pull secrets from Doppler. Use JSON + jq to URL-encode '$' as '%24' in URL-valued
# secrets so Docker Compose env_file does not expand variables like $Af5B into empty
# strings. '$$' escaping does NOT work reliably in env_file across Docker Compose
# versions — some versions perform a second expansion pass that eats the resulting '$'.
#
# '%24' encoding is scoped to keys ending in _URL, _URI, or _DSN: only URL parsers
# (e.g. PostgreSQL libpq, postgres.js) decode percent-encoded characters. Applying it
# to non-URL secrets (API tokens, passwords used outside a URL context) would corrupt
# literal '$' characters in those values.
#
# Values are unquoted. In Docker Compose env_file, unquoted values are literal up to
# the newline — no escaping needed. Assumption: secrets do not contain newlines.
echo "Pulling secrets from Doppler..."
ENVFILE=$(mktemp /tmp/.env.deploy.XXXXXX)
chmod 600 "$ENVFILE"
trap 'rm -f "$ENVFILE"' EXIT
# DOPPLER_PROJECT and DOPPLER_CONFIG must be set in the environment.
: "${DOPPLER_PROJECT:?DOPPLER_PROJECT required}"
: "${DOPPLER_CONFIG:?DOPPLER_CONFIG required}"
doppler secrets download \
  --no-file \
  --format json \
  --project "$DOPPLER_PROJECT" \
  --config "$DOPPLER_CONFIG" \
  | jq -r 'to_entries[] | if (.key | test("_URL$|_URI$|_DSN$")) then "\(.key)=\(.value | gsub("\\$"; "%24"))" else "\(.key)=\(.value)" end' \
  > "$ENVFILE"
if [[ ! -s "$ENVFILE" ]]; then
  echo "Error: .env file is empty — check Doppler auth; aborting" >&2; exit 1
fi

echo "Syncing files to ${HOST}:${DEPLOY_DIR}..."
ssh "${SSH_OPTS[@]}" "${HOST}" "mkdir -p '${DEPLOY_DIR}'"

# Always sync base files
rsync -az -e "ssh ${SSH_OPTS[*]}" --exclude '.git' --exclude 'node_modules' \
  Dockerfile \
  docker-compose.yml \
  start.sh \
  "${HOST}:${DEPLOY_DIR}/"

# Sync adapter directory if selected
if [[ -n "$ADAPTER" ]]; then
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    "${ADAPTER}/" \
    "${HOST}:${DEPLOY_DIR}/${ADAPTER}/"
fi

# Upload .env — pre-create with 600 so it is never world-readable, even briefly
ssh "${SSH_OPTS[@]}" "${HOST}" "install -m 600 /dev/null '${DEPLOY_DIR}/.env'"
scp "${SSH_OPTS[@]}" "$ENVFILE" "${HOST}:${DEPLOY_DIR}/.env"
ssh "${SSH_OPTS[@]}" "${HOST}" "chmod 600 '${DEPLOY_DIR}/.env'"

# Compose files: base + adapter override if selected
COMPOSE_FILES="-f docker-compose.yml"
if [[ -n "$ADAPTER" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f ${ADAPTER}/docker-compose.yml"
fi

echo "Building and starting containers..."
ssh "${SSH_OPTS[@]}" "${HOST}" "
  if ! command -v docker &>/dev/null; then
    echo 'Installing Docker...'
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh && rm -f /tmp/get-docker.sh
  fi
  cd '${DEPLOY_DIR}'
  # Build base image first (tagged runtime:base) so adapter Dockerfiles can FROM it
  docker compose -f docker-compose.yml build
  # Build adapter overlay (if any) on top of the base
  docker compose ${COMPOSE_FILES} build
  docker compose ${COMPOSE_FILES} up -d
"

echo ""
echo "=== Done ==="
echo "Check logs: ssh -i ${SSH_KEY} ${HOST} 'cd ${DEPLOY_DIR} && docker compose ${COMPOSE_FILES} logs -f runtime'"
