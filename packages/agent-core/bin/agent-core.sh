#!/bin/sh
NODE_OPTIONS="--import tsx/esm ${NODE_OPTIONS:-}" exec node "$(dirname "$0")/agent-core.js" "$@"
