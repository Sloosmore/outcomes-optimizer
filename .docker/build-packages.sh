#!/bin/sh
set -e

# Build a single package with skip logic.
# Args: <workspace-relative-path> <package-name>
build_pkg() {
  PKG_DIR="/workspace/$1"
  PKG_NAME="$2"

  if [ ! -d "$PKG_DIR" ]; then
    echo "build-packages: skipping $PKG_NAME (directory not found)"
    return 0
  fi

  # Hash src/, package.json, and tsconfig*.json for skip check
  FILE_LIST=$(find "$PKG_DIR/src" "$PKG_DIR/package.json" "$PKG_DIR"/tsconfig*.json \
    -type f 2>/dev/null | sort)
  if [ -z "$FILE_LIST" ]; then
    # No files to hash — always build (can't prove unchanged)
    HASH=""
  else
    HASH=$(echo "$FILE_LIST" | xargs sha256sum 2>/dev/null | sha256sum | cut -d" " -f1)
  fi

  HASH_FILE="$PKG_DIR/dist/.build-hash"
  if [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$HASH" ]; then
    echo "build-packages: $PKG_NAME unchanged — skipping"
    return 0
  fi

  echo "build-packages: building $PKG_NAME..."
  cd "$PKG_DIR" && pnpm run build

  mkdir -p "$PKG_DIR/dist"
  echo "$HASH" > "$HASH_FILE"
  echo "build-packages: $PKG_NAME done"
}

# Build in dependency order as specified
build_pkg "packages/logger"            "logger"
build_pkg "packages/agent-events"     "agent-events"
build_pkg "packages/database"         "database"
build_pkg "packages/agent-core"       "agent-core"
build_pkg "packages/auth"             "auth"
build_pkg "packages/sandbox"          "sandbox"
build_pkg "packages/duoidal-cli"      "duoidal-cli"

# Build remaining packages/* that have a build script
for PKG_DIR in /workspace/packages/*/; do
  PKG_NAME=$(basename "$PKG_DIR")
  # Skip already-built packages
  case "$PKG_NAME" in
    agent-events|database|agent-core|auth|sandbox|duoidal-cli) continue ;;
  esac
  # Check if the package has a build script
  if [ -f "$PKG_DIR/package.json" ] && grep -q '"build"' "$PKG_DIR/package.json"; then
    build_pkg "packages/$PKG_NAME" "$PKG_NAME"
  fi
done

echo "build-packages: all packages built"

# Generate pre-compiled dispatch bundles AFTER workspace packages so the bundler
# can resolve workspace deps via packages/*/dist (built above) and inline them
# into self-contained ESM bundles. The bundles eliminate tsx cold-start on the
# dispatch hot path. They are gitignored — derived artifacts, regenerated here.
if [ -f /workspace/utils/dispatch/build-bundles.mjs ]; then
  echo "build-packages: generating dispatch bundles..."
  cd /workspace && node utils/dispatch/build-bundles.mjs && echo "build-packages: dispatch bundles done"
fi
