#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REGISTRY="$SCRIPT_DIR/registry.json"

usage() {
  echo "Usage: $0 <name>"
  echo "  name: package name as listed in publish/registry.json"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

NAME="$1"

# Find entry in registry by name
ENTRY=$(REGISTRY="$REGISTRY" PKG_NAME="$NAME" python3 -c "
import json, os, sys
registry = json.load(open(os.environ['REGISTRY']))
name = os.environ['PKG_NAME']
for pkg in registry.get('packages', []):
    if pkg['name'] == name:
        print(json.dumps(pkg))
        sys.exit(0)
print('NOT_FOUND')
sys.exit(1)
" 2>&1) || { echo "ERROR: Could not read registry.json"; exit 1; }

if [[ "$ENTRY" == "NOT_FOUND" ]]; then
  echo "ERROR: No package named '$NAME' found in registry.json"
  exit 1
fi

PKG_TYPE=$(echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['type'])")
PKG_PATH=$(echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['path'])")
PKG_GITHUB=$(echo "$ENTRY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['github'])")

if [[ "$PKG_TYPE" != "package" ]]; then
  echo "ERROR: push.sh only supports type 'package', got '$PKG_TYPE'"
  exit 1
fi

SRC_DIR="$REPO_ROOT/$PKG_PATH"
# Derive skill dir from the package path basename (e.g. packages/agent-email -> agent-email)
PKG_BASENAME=$(basename "$PKG_PATH")
# Try skills/<basename> first, then skills/<name>
if [[ -d "$REPO_ROOT/skills/$PKG_BASENAME" ]]; then
  SKILL_DIR="$REPO_ROOT/skills/$PKG_BASENAME"
else
  SKILL_DIR="$REPO_ROOT/skills/$NAME"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: Source directory not found: $SRC_DIR"
  exit 1
fi

echo "==> Publishing '$NAME' to GitHub repo '$PKG_GITHUB'"
echo "    Source: $SRC_DIR"
echo "    Skill dir: $SKILL_DIR"

# Create temp dir
TMPDIR=$(mktemp -d)
trap "rm -rf '$TMPDIR'" EXIT

TMPWORK="$TMPDIR/repo"
mkdir -p "$TMPWORK"

# Copy package source files
echo "==> Copying package source files..."
cp -r "$SRC_DIR/." "$TMPWORK/"

# Copy SKILL.md from skills/<name>/ to temp dir root
if [[ -f "$SKILL_DIR/SKILL.md" ]]; then
  echo "==> Copying SKILL.md from $SKILL_DIR..."
  cp "$SKILL_DIR/SKILL.md" "$TMPWORK/SKILL.md"
else
  echo "WARNING: No SKILL.md found at $SKILL_DIR/SKILL.md"
fi

# Copy references/ directory if it exists
if [[ -d "$SKILL_DIR/references" ]]; then
  echo "==> Copying references/ from $SKILL_DIR..."
  cp -r "$SKILL_DIR/references" "$TMPWORK/references"
fi

# Strip workspace: refs from package.json in temp dir
TMPKG="$TMPWORK/package.json"
if [[ -f "$TMPKG" ]]; then
  echo "==> Stripping workspace: references from package.json..."
  TMPKG="$TMPKG" python3 -c "
import json, os, sys

pkg_path = os.environ['TMPKG']

with open(pkg_path, 'r') as f:
    pkg = json.load(f)

def strip_workspace(deps):
    if not deps:
        return deps
    result = {}
    for k, v in deps.items():
        if isinstance(v, str) and v.startswith('workspace:'):
            # Try to extract a semver from workspace:^x.y.z, otherwise skip
            stripped = v[len('workspace:'):]
            if stripped and stripped not in ('*', '^', '~'):
                result[k] = stripped
            # else: drop the dep entirely
        else:
            result[k] = v
    return result

for field in ('dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
    if field in pkg:
        pkg[field] = strip_workspace(pkg[field])

with open(pkg_path, 'w') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')

print('  package.json cleaned')
"
fi

# Check if GitHub repo already exists
echo "==> Checking if $PKG_GITHUB exists on GitHub..."
if gh repo view "$PKG_GITHUB" &>/dev/null; then
  echo "    Repo already exists."
  REPO_URL=$(gh repo view "$PKG_GITHUB" --json url -q '.url')
else
  echo "    Creating repo $PKG_GITHUB..."
  gh repo create "$PKG_GITHUB" --public --description "$(TMPKG="$TMPKG" python3 -c "import json,os; d=json.load(open(os.environ['TMPKG'])); print(d.get('description', ''))" 2>/dev/null || echo '')"
  REPO_URL=$(gh repo view "$PKG_GITHUB" --json url -q '.url')
fi

echo "    Repo URL: $REPO_URL"

# Get SSH or HTTPS clone URL
CLONE_URL=$(gh repo view "$PKG_GITHUB" --json sshUrl -q '.sshUrl' 2>/dev/null || echo "")
if [[ -z "$CLONE_URL" ]]; then
  CLONE_URL="https://github.com/$PKG_GITHUB.git"
fi

# Use token-authenticated HTTPS URL in CI
if [[ -n "${GH_TOKEN:-}" ]]; then
  HTTPS_URL="https://x-access-token:${GH_TOKEN}@github.com/$PKG_GITHUB.git"
else
  HTTPS_URL="https://github.com/$PKG_GITHUB.git"
fi

# Initialize temp git repo and force push
echo "==> Initializing git repo in temp dir..."
cd "$TMPWORK"
git init -b main
git config user.email "publish@dispatch.local"
git config user.name "Dispatch Publisher"
git add -A
git commit -m "chore: publish $NAME"

echo "==> Force pushing to $PKG_GITHUB..."
# Try HTTPS first (works in CI without SSH keys)
if git remote add origin "$HTTPS_URL" && git push --force origin main; then
  echo "==> Successfully pushed to $PKG_GITHUB"
else
  echo "ERROR: Failed to push to $HTTPS_URL"
  exit 1
fi

echo ""
echo "Done! '$NAME' published to https://github.com/$PKG_GITHUB"
