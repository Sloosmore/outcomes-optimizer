#!/usr/bin/env bash
# Setup script for Hetzner self-hosted GitHub Actions runner
#
# Usage:
#   ssh root@YOUR_SERVER_IP 'bash -s' < scripts/setup-hetzner-runner.sh
#
# Or SCP and run:
#   scp scripts/setup-hetzner-runner.sh root@YOUR_SERVER_IP:~/
#   ssh root@YOUR_SERVER_IP './setup-hetzner-runner.sh'
#
# Prerequisites:
#   - Hetzner CX22+ running Ubuntu 24.04
#   - GitHub runner token from:
#     https://github.com/<your-org>/<your-repo>/settings/actions/runners/new

set -euo pipefail

REPO_URL="https://github.com/<your-org>/<your-repo>"
RUNNER_VERSION="2.331.0"

# Prompt for token if not set
if [ -z "${RUNNER_TOKEN:-}" ]; then
  read -rp "GitHub runner token (from repo Settings → Actions → Runners → New): " RUNNER_TOKEN
fi

# Prompt for runner name if not set
if [ -z "${RUNNER_NAME:-}" ]; then
  read -rp "Runner name (e.g. hetzner-1, hetzner-2): " RUNNER_NAME
fi

echo "==> Updating system"
apt update && apt upgrade -y

echo "==> Installing system dependencies"
apt install -y \
  curl \
  git \
  build-essential \
  libssl-dev \
  unzip \
  jq \
  ca-certificates \
  gnupg

echo "==> Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "==> Installing Playwright system dependencies"
npx playwright install-deps chromium

echo "==> Creating runner user"
id -u runner &>/dev/null || useradd -m -s /bin/bash runner

echo "==> Configuring runner-local npm prefix"
su - runner -c "mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global"

echo "==> Installing gh CLI"
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt update -qq && apt install -y gh

echo "==> Setting up GitHub Actions runner"
RUNNER_DIR="/home/runner/actions-runner"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

curl -sL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" -o runner.tar.gz
tar xzf runner.tar.gz
rm runner.tar.gz
chown -R runner:runner "$RUNNER_DIR"

echo "==> Configuring runner"
su -c "./config.sh --url '$REPO_URL' --token '$RUNNER_TOKEN' --name '$RUNNER_NAME' --labels self-hosted,linux,x64 --unattended" runner

echo "==> Setting runner environment"
cat >> "$RUNNER_DIR/.env" <<'ENVEOF'
NPM_CONFIG_PREFIX=/home/runner/.npm-global
PATH=/home/runner/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENVEOF

echo "==> Installing runner as system service"
./svc.sh install runner
./svc.sh start

echo "==> Verifying"
./svc.sh status

echo ""
echo "============================================"
echo "  Runner '$RUNNER_NAME' is live and listening for jobs!"
echo "  "
echo "  To check status:  ssh root@THIS_IP 'cd /home/runner/actions-runner && ./svc.sh status'"
echo "  To view logs:     ssh root@THIS_IP 'journalctl -u actions.runner.* -f'"
echo "  To add another:   Create /home/runner/actions-runner-2 and repeat"
echo "============================================"
echo ""
echo "⚠️  ACTION REQUIRED: Update docs/runners/README.md"
echo "  Add a row to the Instances table:"
echo "  | $RUNNER_NAME | <THIS_IP> | <ROOT_PASSWORD> | $RUNNER_NAME | Active |"
echo ""
