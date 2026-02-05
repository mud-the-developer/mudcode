#!/usr/bin/env bash
# Claude Code PostToolUse hook
# Forwards tool outputs to Discord via the bridge HTTP server

set -euo pipefail

# Configuration
BRIDGE_PORT="${AGENT_DISCORD_PORT:-18470}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# YOLO mode: skip sending tool outputs to Discord (only Stop hook sends final response)
if [[ "${AGENT_DISCORD_YOLO:-}" == "1" ]]; then
  cat << 'EOF'
{"decision": "approve", "reason": "YOLO mode"}
EOF
  exit 0
fi

# Only forward if project is configured
if [[ -n "$PROJECT_NAME" ]]; then
  # Send to bridge server (fire and forget, don't block Claude)
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -d "$HOOK_INPUT" \
    "http://127.0.0.1:${BRIDGE_PORT}/hook/${PROJECT_NAME}/claude" \
    --max-time 2 >/dev/null 2>&1 || true
fi

# Return success response for Claude Code
cat << 'EOF'
{"decision": "approve", "reason": "Hook processed"}
EOF
