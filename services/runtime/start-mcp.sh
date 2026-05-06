#!/bin/bash
set -e
# Start Mermaid MCP server on port 3737
# This script is called from bootstrap.sh at sandbox provisioning time.
# The server renders Mermaid diagrams and serves them at http://localhost:3737/view/:id

MCP_SERVER_PORT="${MERMAID_MCP_PORT:-3737}"
MCP_SERVER_DIR="/opt/mermaid-server"

if [ ! -d "$MCP_SERVER_DIR" ]; then
  echo "[mcp-start] ERROR: $MCP_SERVER_DIR not found — was the sandbox provisioned correctly?" >&2
  exit 1
fi

# Check if port is already in use
if nc -z localhost "$MCP_SERVER_PORT" 2>/dev/null; then
  echo "[mcp-start] Port $MCP_SERVER_PORT already in use — MCP server may already be running" >&2
  exit 0
fi

exec node "$MCP_SERVER_DIR/server.js" --port "$MCP_SERVER_PORT"
