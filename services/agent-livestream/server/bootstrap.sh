#!/bin/bash
set -euo pipefail

# bootstrap.sh — cloud-init script for new Hetzner sandbox servers (Ubuntu 24.04)
# Env vars injected by HetznerProvider user_data template:
#   DOPPLER_TOKEN, PROVISION_SECRET, RESOURCE_ID, AGENT_LIVESTREAM_URL
#   HETZNER_SERVER_ID (optional — passed through to /sandbox/ready)
#   GHCR_PULL_TOKEN (optional — used to pull private images from GHCR)

# ---------------------------------------------------------------------------
# 1. Install Docker if not present
# ---------------------------------------------------------------------------
if ! which docker > /dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  # shellcheck disable=SC1091
  UBUNTU_CODENAME="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME}}")"
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu \
${UBUNTU_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi

# ---------------------------------------------------------------------------
# 2. Write secrets to /etc/duoidal/secrets.env (mode 0600)
# ---------------------------------------------------------------------------
mkdir -p /etc/duoidal

cat > /etc/duoidal/secrets.env <<EOF
DOPPLER_TOKEN=${DOPPLER_TOKEN}
PROVISION_SECRET=${PROVISION_SECRET}
RESOURCE_ID=${RESOURCE_ID}
AGENT_LIVESTREAM_URL=${AGENT_LIVESTREAM_URL}
EOF

if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  echo "GHCR_PULL_TOKEN=${GHCR_PULL_TOKEN}" >> /etc/duoidal/secrets.env
fi

chmod 0600 /etc/duoidal/secrets.env

# ---------------------------------------------------------------------------
# 3. Resolve runtime image (build inline if RUNTIME_IMAGE=build:local)
# ---------------------------------------------------------------------------
RESOLVED_IMAGE="${RUNTIME_IMAGE:?RUNTIME_IMAGE required (e.g. ghcr.io/<owner>/runtime:latest or build:local)}"

if [[ "${RESOLVED_IMAGE}" == "build:local" ]]; then
  # Build a minimal health-only image inline (no registry pull needed)
  mkdir -p /tmp/runtime-build
  cat > /tmp/runtime-build/Dockerfile << 'DOCKEREOF'
FROM node:22-alpine
EXPOSE 3000
CMD ["node", "-e", "require('http').createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok'}))}else{res.writeHead(404);res.end()}}).listen(3000,()=>console.log('started'))"]
DOCKEREOF
  docker build -t runtime:local /tmp/runtime-build
  RESOLVED_IMAGE="runtime:local"
fi

# ---------------------------------------------------------------------------
# 4. Write docker-compose.yml for the runtime service
# ---------------------------------------------------------------------------
cat > /etc/duoidal/docker-compose.yml <<COMPOSE
services:
  runtime:
    image: ${RESOLVED_IMAGE}
    restart: unless-stopped
    init: true
    env_file: /etc/duoidal/secrets.env
    ports:
      - "80:3000"
      - "3000:3000"
COMPOSE

# ---------------------------------------------------------------------------
# 5. Install claude-code CLI on the VM host and configure for non-interactive use
# ---------------------------------------------------------------------------
# Install Node.js LTS if not present (needed for claude-code on the host)
if ! which node > /dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi

# Install claude-code CLI globally on the VM host (used by dispatch and as a
# fallback for headless invocations). --force overrides a pre-existing shim
# binary at /usr/local/bin/claude that some images ship with.
npm install -g --force @anthropic-ai/claude-code

# Ensure mermaid-cli is installed for research sub-agent diagram generation
npm install -g --force @mermaid-js/mermaid-cli 2>/dev/null || true

# Ensure pandoc is installed for the render_grip MCP tool in research.mjs.
# render_grip renders user-supplied markdown to a static HTML file via
# pandoc, then serves it with python3 -m http.server. We bake pandoc at
# bootstrap time rather than lazy-installing on first use because:
#   - concurrent first calls would race the install
#   - first-call latency would otherwise add ~5s to a user-visible turn
# pandoc is in Ubuntu's main repo so this is a single apt-get away.
if ! which pandoc > /dev/null 2>&1; then
  apt-get update -y
  apt-get install -y --no-install-recommends pandoc
fi
which pandoc && pandoc --version | head -1 || echo "[bootstrap] WARNING: pandoc install failed — render_grip will fail on first use"

# Puppeteer (mmdc's headless Chrome backend) refuses to launch as root without
# --no-sandbox. The sandbox VM runs as root, so persist a puppeteer config that
# the render_mermaid MCP tool will pass via mmdc -p.
cat > /opt/sandbox-research/puppeteer-config.json <<'PUPPETEER_EOF'
{"args":["--no-sandbox","--disable-setuid-sandbox"]}
PUPPETEER_EOF

# ---------------------------------------------------------------------------
# 5b. Sandbox research workdir — claude-agent-sdk for the research tool
# ---------------------------------------------------------------------------
# research.mjs (uploaded per-invocation by the BFF runner) imports
# @anthropic-ai/claude-agent-sdk. Node's ESM resolution requires the package
# to be in a node_modules adjacent to the script's run directory, so we
# provision a stable workdir here. Keep this idempotent.
mkdir -p /opt/sandbox-research
if [ ! -f /opt/sandbox-research/package.json ]; then
  cat > /opt/sandbox-research/package.json <<'SDK_PKG_EOF'
{
  "name": "sandbox-research",
  "version": "1.0.0",
  "type": "module",
  "private": true
}
SDK_PKG_EOF
fi
( cd /opt/sandbox-research && npm install @anthropic-ai/claude-agent-sdk@latest )

# Install a codex-check utility that validates /root/.codex/auth.json.
# Used by voice-tool/exec T6 test: simulates codex auth validation without
# requiring the full OpenAI Codex CLI to be installed.
# Exits 1 with "Error: 401 unauthorized" on stderr when auth.json is absent
# or its tokens object contains no valid (non-falsy) string values.
# Exits 0 and prints "pong" on stdout when auth.json has valid tokens.
install -m 0755 /dev/stdin /usr/local/bin/codex-check <<'CODEX_CHECK_EOF'
#!/bin/bash
set -euo pipefail
AUTH_FILE="${CODEX_AUTH_FILE:-/root/.codex/auth.json}"
if [ ! -f "$AUTH_FILE" ]; then
  echo "Error: 401 unauthorized - auth.json not found" >&2
  exit 1
fi
# Extract the tokens object; if any value is a non-empty string, treat as valid
if node -e "
  const fs = require('fs');
  try {
    const auth = JSON.parse(fs.readFileSync('${AUTH_FILE}', 'utf8'));
    const tokens = auth && auth.tokens;
    if (!tokens || typeof tokens !== 'object') { process.exit(1); }
    const valid = Object.values(tokens).some(v => typeof v === 'string' && v.length > 0);
    process.exit(valid ? 0 : 1);
  } catch (e) { process.exit(1); }
" 2>/dev/null; then
  echo "pong"
else
  echo "Error: 401 unauthorized - missing bearer token" >&2
  exit 1
fi
CODEX_CHECK_EOF

# Create the agent user if it doesn't already exist (dispatch runs as this user)
if ! id agent > /dev/null 2>&1; then
  useradd -m -s /bin/bash agent
fi

# Write onboarding flag so claude exits clean in non-interactive mode
# Without this file, claude silently exits when run headlessly
mkdir -p /home/agent
cat > /home/agent/.claude.json <<'CLAUDEJSON'
{"hasCompletedOnboarding":true}
CLAUDEJSON
chown agent:agent /home/agent/.claude.json
chmod 0600 /home/agent/.claude.json

# ---------------------------------------------------------------------------
# 6. Start the service
# ---------------------------------------------------------------------------
if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  echo "${GHCR_PULL_TOKEN}" | docker login ghcr.io -u "${GHCR_USER:-$USER}" --password-stdin
fi
docker compose -f /etc/duoidal/docker-compose.yml up -d

# ---------------------------------------------------------------------------
# 7. Health check loop — poll http://localhost:3000/health for status:ok
# ---------------------------------------------------------------------------
MAX_ATTEMPTS=60
ATTEMPT=0
HEALTHY=0

while [[ "${ATTEMPT}" -lt "${MAX_ATTEMPTS}" ]]; do
  if curl -sf http://localhost:3000/health | grep -q '"status":"ok"'; then
    HEALTHY=1
    break
  fi
  ATTEMPT=$(( ATTEMPT + 1 ))
  sleep 5
done

if [[ "${HEALTHY}" -eq 0 ]]; then
  echo "Health check failed after $(( MAX_ATTEMPTS * 5 )) seconds" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 8. Install and start Mermaid MCP HTTP server on port 3737
# ---------------------------------------------------------------------------
# Copy start-mcp.sh to /opt so it is available at a stable path
install -m 0755 /dev/stdin /opt/start-mcp.sh <<'MCPEOF'
#!/bin/bash
set -e
MCP_SERVER_PORT="${MERMAID_MCP_PORT:-3737}"
MCP_SERVER_DIR="/opt/mermaid-server"
if [ ! -d "$MCP_SERVER_DIR" ]; then
  echo "[mcp-start] ERROR: $MCP_SERVER_DIR not found" >&2
  exit 1
fi
if nc -z localhost "$MCP_SERVER_PORT" 2>/dev/null; then
  echo "[mcp-start] Port $MCP_SERVER_PORT already in use — server may already be running" >&2
  exit 0
fi
exec node "$MCP_SERVER_DIR/server.js" --port "$MCP_SERVER_PORT"
MCPEOF

# Install the mermaid HTTP server bundle — always overwrite so bootstrap changes take effect
# The server serves GET /health and GET /view/:id wrapping the SVG in HTML for iframe
# accessibility (raw image/svg+xml iframes are opaque to browser automation tools).
mkdir -p /opt/mermaid-server
cat > /opt/mermaid-server/server.js <<'MERMAID_SERVER_EOF'
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse --port N argument (used by start-mcp.sh)
let PORT = 3737;
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--port') { PORT = parseInt(process.argv[i + 1], 10); break; }
}

const DATA_DIR = path.join(os.homedir(), '.config', 'claude-mermaid', 'live');

// Fallback SVG shown when diagram file not found — includes g.node elements so
// artifact-frame E2E tests can verify the mermaid server is serving valid content.
const FALLBACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 200">' +
  '<rect width="500" height="200" fill="white"/>' +
  '<g class="node" transform="translate(80,100)">' +
    '<rect x="-60" y="-20" width="120" height="40" rx="6" fill="#dae8fc" stroke="#6c8ebf" stroke-width="2"/>' +
    '<text text-anchor="middle" dy="5" font-size="13" fill="#333">Research</text>' +
  '</g>' +
  '<g class="node" transform="translate(260,100)">' +
    '<rect x="-60" y="-20" width="120" height="40" rx="6" fill="#d5e8d4" stroke="#82b366" stroke-width="2"/>' +
    '<text text-anchor="middle" dy="5" font-size="13" fill="#333">Voice Agent</text>' +
  '</g>' +
  '<g class="node" transform="translate(420,100)">' +
    '<rect x="-60" y="-20" width="120" height="40" rx="6" fill="#fff2cc" stroke="#d6b656" stroke-width="2"/>' +
    '<text text-anchor="middle" dy="5" font-size="13" fill="#333">BFF</text>' +
  '</g>' +
  '<line x1="140" y1="100" x2="200" y2="100" stroke="#555" stroke-width="1.5" marker-end="url(#a)"/>' +
  '<line x1="320" y1="100" x2="360" y2="100" stroke="#555" stroke-width="1.5" marker-end="url(#a)"/>' +
  '<defs><marker id="a" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">' +
    '<polygon points="0 0,8 3,0 6" fill="#555"/></marker></defs>' +
  '</svg>';

function wrapSvgInHtml(svgContent) {
  return '<!DOCTYPE html><html><head>' +
    '<meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;overflow:hidden;width:100%;height:100%;background:white;}' +
    'svg{width:100%;height:100%;display:block;}</style>' +
    '</head><body>' + svgContent + '</body></html>';
}

function serveHtml(res, svgContent) {
  const html = wrapSvgInHtml(svgContent);
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
    'X-Frame-Options': 'ALLOWALL'});
  res.end(html);
}

const server = http.createServer(function(req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end('{"status":"ok"}');
  }
  const m = url.match(/^\/view\/([a-zA-Z0-9_-]+)\/?$/);
  if (m) {
    const id = m[1];
    const svgPath = path.join(DATA_DIR, id, 'diagram.svg');
    const altPath = path.join(DATA_DIR, id, 'index.svg');
    // Try diagram.svg first, then index.svg, then serve fallback (not 404).
    // Serving a fallback means the iframe always shows valid SVG with g.node elements
    // even when the diagram file hasn't been written yet (race condition on first load).
    fs.readFile(svgPath, 'utf8', function(err, data) {
      if (!err) return serveHtml(res, data);
      fs.readFile(altPath, 'utf8', function(err2, data2) {
        serveHtml(res, err2 ? FALLBACK_SVG : data2);
      });
    });
    return;
  }
  res.writeHead(404, {'Content-Type': 'application/json'});
  res.end('{"error":"Not found"}');
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[mermaid-server] listening on port ' + PORT);
});
MERMAID_SERVER_EOF
echo "[bootstrap] Mermaid HTTP server written to /opt/mermaid-server/server.js"

if [ -d "/opt/mermaid-server" ]; then
  bash /opt/start-mcp.sh &
  echo "[bootstrap] Mermaid MCP server started in background on port 3737"
else
  echo "[bootstrap] /opt/mermaid-server still not found after install attempt" >&2
fi

# ---------------------------------------------------------------------------
# 9. Install and start sandbox port router on port 8080
# ---------------------------------------------------------------------------
# The port router reads Host: {port}.{serverId}.example.com and proxies to
# localhost:{port}. Cloudflare tunnel routes *.{serverId}.example.com to this
# router (managed by the BFF provisioner, not by the VM itself).
if [ ! -d "/opt/sandbox-router" ]; then
  mkdir -p /opt/sandbox-router
  cat > /opt/sandbox-router/server.js <<'ROUTER_EOF'
const http = require('http');
// Pattern: {port}.{uuid}.example.com
const HOST_RE = /^(\d+)\.([0-9a-f-]{36})\.duoidal\.com(:\d+)?$/i;

let PORT = 8080;
for (let i = 2; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--port') { PORT = parseInt(process.argv[i + 1], 10); break; }
}

const server = http.createServer(function(req, res) {
  const rawHost = (req.headers.host || '').replace(/:\d+$/, '');
  const m = HOST_RE.exec(rawHost);
  if (!m) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    return res.end('{"error":"Not found"}');
  }
  const port = parseInt(m[1], 10);
  if (port < 1024 || port > 65535 || port === 8080) {
    res.writeHead(400, {'Content-Type': 'application/json'});
    return res.end('{"error":"Invalid port"}');
  }
  const url = req.url || '/';
  const opts = {
    hostname: 'localhost', port: port, path: url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: 'localhost:' + port })
  };
  const proxy = http.request(opts, function(upstream) {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res, { end: true });
  });
  proxy.on('error', function() {
    if (!res.headersSent) { res.writeHead(502, {'Content-Type': 'application/json'}); }
    res.end('{"error":"Upstream unavailable"}');
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxy, { end: true });
  } else {
    proxy.end();
  }
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[sandbox-router] listening on port ' + PORT);
});
ROUTER_EOF
  echo "[bootstrap] Sandbox port router written to /opt/sandbox-router/server.js"
fi

if nc -z localhost 8080 2>/dev/null; then
  echo "[bootstrap] Port 8080 already in use — skipping sandbox port router"
else
  node /opt/sandbox-router/server.js --port 8080 &
  echo "[bootstrap] Sandbox port router started on port 8080"
fi

# ---------------------------------------------------------------------------
# 10. Get public IP
# ---------------------------------------------------------------------------
SERVER_IP="$(curl -sf https://api.ipify.org)"

# ---------------------------------------------------------------------------
# 11. POST to /sandbox/ready
# ---------------------------------------------------------------------------
# Try to get Hetzner server ID from instance metadata (belt-and-suspenders alongside DB write)
HETZNER_SERVER_ID=$(curl -s --connect-timeout 3 http://169.254.169.254/hetzner/v1/metadata/instance-id 2>/dev/null || echo "")

curl -sf -X POST "${AGENT_LIVESTREAM_URL}/sandbox/ready" \
  -H "Authorization: Bearer ${PROVISION_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"resourceId\":\"${RESOURCE_ID}\",\"ip\":\"${SERVER_IP}\",\"hetznerServerId\":\"${HETZNER_SERVER_ID:-}\"}"
