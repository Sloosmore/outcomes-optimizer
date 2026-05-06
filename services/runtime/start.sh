#!/bin/bash
# Runtime startup script
# Mounts R2 (if configured), seeds repos, and sets up Claude credentials.

set -e

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "=== start.sh starting ==="

# ============================================================
# HEALTH SERVER (port 3000) — start early so bootstrap.sh can poll
# ============================================================
node -e "require('http').createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok'}))}else{res.writeHead(404);res.end()}}).listen(3000,()=>console.log('health server started on port 3000'))" &
log "Health server started on port 3000"

# ============================================================
# CLIPROXYAPI — credential proxy for Claude API routing (port 8317)
# ============================================================
mkdir -p /opt/cliproxyapi/auths
cliproxyapi --config /opt/cliproxyapi/config.yaml &>/var/log/cliproxyapi.log &
CLIPROXY_PID=$!
for _i in $(seq 1 10); do
  if nc -z 127.0.0.1 8317 2>/dev/null; then
    break
  fi
  if ! kill -0 "$CLIPROXY_PID" 2>/dev/null; then
    log "FATAL: CLIProxyAPI exited during startup — check /var/log/cliproxyapi.log"
    cat /var/log/cliproxyapi.log >&2
    exit 1
  fi
  sleep 1
done
if ! nc -z 127.0.0.1 8317 2>/dev/null; then
  log "FATAL: CLIProxyAPI not listening on port 8317 after 10s"
  cat /var/log/cliproxyapi.log >&2
  exit 1
fi
log "CLIProxyAPI started (port 8317, PID: $CLIPROXY_PID)"

# ============================================================
# PATHS
# ============================================================

MOUNT_POINT="/mnt/r2"
R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

log "R2_BUCKET=$R2_BUCKET"
log "R2_ACCESS_KEY_ID set: $([ -n "$R2_ACCESS_KEY_ID" ] && echo YES || echo NO)"
log "R2_SECRET_ACCESS_KEY set: $([ -n "$R2_SECRET_ACCESS_KEY" ] && echo YES || echo NO)"
log "CF_ACCOUNT_ID set: $([ -n "$CF_ACCOUNT_ID" ] && echo YES || echo NO)"

# ============================================================
# HELPERS
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

# Clone/pull a registry of repos to /root/repos/ at every boot.
# Idempotent: clones on first boot, fast-forward-pulls on subsequent boots.
# Private repos require GH_TOKEN in the environment.
seed_repos() {
    local repos_dir="/root/repos"
    mkdir -p "$repos_dir"

    local REPO_REGISTRY=(
        "CLIProxyAPI https://github.com/router-for-me/CLIProxyAPI.git public"
    )

    local askpass_script="" token_file=""
    if [ -n "$GH_TOKEN" ]; then
        token_file=$(mktemp) && chmod 600 "$token_file"
        printf '%s' "$GH_TOKEN" > "$token_file"
        askpass_script=$(mktemp) && chmod 700 "$askpass_script"
        printf '#!/bin/sh\ncat %s\n' "$token_file" > "$askpass_script"
    fi
    _seed_repos_cleanup() { rm -f "$askpass_script" "$token_file" 2>/dev/null || true; }
    trap _seed_repos_cleanup RETURN

    for entry in "${REPO_REGISTRY[@]}"; do
        local name url visibility
        read -r name url visibility <<< "$entry"
        local dest="$repos_dir/$name"

        if [ "$visibility" = "private" ] && [ -z "$GH_TOKEN" ]; then
            log "seed_repos: WARNING: $name is private but GH_TOKEN is not set — clone will likely fail"
        fi

        if [ -d "$dest/.git" ]; then
            git -C "$dest" remote set-url origin "$url" 2>/dev/null || true
            local wt_count
            wt_count=$(git -C "$dest" worktree list --porcelain 2>/dev/null | grep -c '^worktree ') || wt_count=999
            if [ "$wt_count" -gt 1 ]; then
                log "seed_repos: $name has active worktrees — skipping reset to preserve dispatch sessions"
            else
                log "seed_repos: $name — pulling latest main"
                if [ -n "$askpass_script" ]; then
                    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass_script" \
                        git -C "$dest" -c "credential.helper=" fetch origin main 2>/dev/null
                else
                    git -C "$dest" fetch origin main 2>/dev/null
                fi && \
                    git -C "$dest" reset --hard origin/main 2>/dev/null || \
                    log "seed_repos: WARNING: pull failed for $name (continuing with existing checkout)"
            fi
        else
            log "seed_repos: cloning $name into $dest..."
            if [ "$visibility" = "private" ] && [ -n "$askpass_script" ]; then
                GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass_script" \
                    git clone --depth 1 "$url" "$dest" 2>&1 | tail -3 || \
                    log "seed_repos: WARNING: clone failed for $name (continuing)"
            else
                git clone --depth 1 "$url" "$dest" 2>&1 | tail -3 || \
                    log "seed_repos: WARNING: clone failed for $name (continuing)"
            fi
        fi
    done

    log "seed_repos: done"
}

# Setup Claude Code OAuth credentials.
# If /root/.claude is volume-mounted, any auto-refreshed token persists across
# container restarts and this function will skip the write.
setup_claude_credentials() {
    # 0g: If ANTHROPIC_API_KEY is set, Claude Code should use API key auth via CLIProxyAPI.
    # Skip OAuth credential write to prevent stale tokens from overriding API key auth.
    if [ -n "$ANTHROPIC_API_KEY" ]; then
        log "ANTHROPIC_API_KEY set — skipping OAuth credential write (API key auth takes precedence)"
        [ -f /root/.claude.json ] || (umask 077 && echo '{}' > /root/.claude.json)
        return
    fi
    (umask 077 && mkdir -p /root/.claude)
    chmod 700 /root/.claude 2>/dev/null || true
    if [ -f /root/.claude/.credentials.json ]; then
        if node -e "try{const c=JSON.parse(require('fs').readFileSync('/root/.claude/.credentials.json','utf8'));process.exit((c.claudeAiOauth&&c.claudeAiOauth.refreshToken)?0:1)}catch(e){process.exit(1)}" 2>/dev/null; then
            log "Claude Code credentials already present (volume-persisted) — skipping write"
            [ -f /root/.claude.json ] || (umask 077 && echo '{}' > /root/.claude.json)
            return
        fi
    fi
    if [ -z "$CLAUDE_REFRESH_TOKEN" ]; then
        log "CLAUDE_REFRESH_TOKEN not set and no existing credentials — Claude Code will not be authenticated"
        return
    fi
    log "Writing Claude Code credentials from CLAUDE_REFRESH_TOKEN..."
    if (umask 077 && node -e "
const fs = require('fs');
const token = process.env.CLAUDE_REFRESH_TOKEN;
const creds = {claudeAiOauth:{accessToken:'',refreshToken:token,expiresAt:0,scopes:['user:inference','user:profile','user:sessions:claude_code'],subscriptionType:'max'}};
fs.writeFileSync('/root/.claude/.credentials.json', JSON.stringify(creds));
" 2>/dev/null); then
        [ -f /root/.claude.json ] || (umask 077 && echo '{}' > /root/.claude.json)
        log "Claude Code credentials written (will auto-refresh on first use)"
    else
        log "WARNING: Failed to write Claude Code credentials — Claude Code may not be authenticated"
    fi
}

# Install duoidal / agent-core CLIs to /usr/local/bin via `npm link`.
#
# The binaries are bin-mapped in packages/duoidal-cli/package.json to dist/index.js.
# After a fresh `docker compose up`, /usr/local/bin/ is empty of these shims — callers
# of `docker exec runtime-runtime-1 duoidal ...` then fail with "executable not found".
# `npm link` creates /usr/local/bin/duoidal and /usr/local/bin/agent-core as symlinks
# pointing at the freshly-built dist. It is idempotent: re-running it when the symlinks
# already exist simply refreshes them (same target, no-op effect).
#
# Requires packages/duoidal-cli/dist/index.js to exist — whoever seeds and builds the
# outcomes-optimizer checkout at $sn_path is responsible for producing that dist. If the
# dist is missing we log a WARNING and continue; the container can still run other
# services, and a later preflight/dispatch build can re-link.
install_cli_binaries() {
    local sn_path="$1"
    local cli_pkg="$sn_path/packages/duoidal-cli"

    if [ ! -d "$cli_pkg" ]; then
        log "install_cli_binaries: WARNING — $cli_pkg does not exist, skipping CLI link"
        return 0
    fi
    if [ ! -f "$cli_pkg/dist/index.js" ]; then
        log "install_cli_binaries: WARNING — $cli_pkg/dist/index.js missing (build not run?), skipping CLI link"
        return 0
    fi

    log "install_cli_binaries: linking duoidal + agent-core from $cli_pkg"
    if (cd "$cli_pkg" && npm link 2>&1 | tail -5); then
        log "install_cli_binaries: duoidal + agent-core linked to /usr/local/bin"
    else
        log "install_cli_binaries: WARNING — npm link failed, CLI not on PATH"
    fi
}

# ============================================================
# CLEAN UP STALE TIGRISFS FROM PREVIOUS RUNS
# ============================================================
log "--- Cleaning up stale tigrisfs processes and mounts ---"
pkill -f "tigrisfs" 2>/dev/null || true
sleep 1
fusermount -u "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT" 2>/dev/null || true
log "Stale tigrisfs cleanup done"

# ============================================================
# FUSE MOUNT R2 (if configured)
# ============================================================

R2_MOUNTED=false

log "--- FUSE mount phase ---"
if r2_configured; then
    log "R2 credentials present — attempting tigrisfs mount of '$R2_BUCKET' at $MOUNT_POINT"
    mkdir -p "$MOUNT_POINT"
    R2_ENDPOINT="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"

    AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
        tigrisfs --endpoint "$R2_ENDPOINT" -f "$R2_BUCKET" "$MOUNT_POINT" &
    TIGRISFS_PID=$!

    for i in $(seq 1 10); do
        if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
            # Protect tigrisfs from OOM killer — it has a large virtual address space
            # (~1.6 GB) that inflates its OOM score despite modest RSS. Without this,
            # the kernel will kill it under memory pressure and break the R2 FUSE mount.
            echo -1000 > "/proc/$TIGRISFS_PID/oom_score_adj" 2>/dev/null \
                && log "tigrisfs OOM protection set (PID: $TIGRISFS_PID)" \
                || log "WARNING: could not set tigrisfs OOM protection (PID: $TIGRISFS_PID)"
            if timeout 5 touch "$MOUNT_POINT/.fuse_test" 2>/dev/null; then
                rm -f "$MOUNT_POINT/.fuse_test" 2>/dev/null || true
                R2_MOUNTED=true
                log "FUSE write test PASSED — using R2 persistent storage"
            else
                log "WARNING: FUSE write test TIMED OUT — R2 mounted but unresponsive"
            fi
            break
        fi
        log "  Waiting for mount... (${i}s)"
        sleep 1
    done

    if [ "$R2_MOUNTED" = "false" ]; then
        log "WARNING: FUSE mount timed out — falling back to local storage"
    fi
else
    log "R2 credentials not present — skipping FUSE mount"
fi

# ============================================================
# SEED REPOS
# ============================================================
log "--- Repo seed phase ---"
seed_repos

# ============================================================
# CLI BINARY INSTALL (duoidal / agent-core on /usr/local/bin)
# ============================================================
# Runs after seed_repos so the outcomes-optimizer checkout, if any, exists at
# /root/repos/outcomes-optimizer. Non-fatal on failure — see function docs.
log "--- CLI binary install phase ---"
install_cli_binaries "/root/repos/outcomes-optimizer"

# ============================================================
# CLAUDE CODE CREDENTIALS
# ============================================================
log "--- Claude Code credential setup ---"
setup_claude_credentials

log "=== Runtime started — waiting for background processes ==="
wait
