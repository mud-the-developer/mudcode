#!/usr/bin/env bash
# Claude Code PreToolUse hook
# Sends tool approval requests to Discord via the bridge HTTP server
# Exit 0 = allow, Exit 2 = deny

set -euo pipefail

# Configuration
BRIDGE_PORT="${AGENT_DISCORD_PORT:-3847}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Skip if project not configured (allow by default)
if [[ -z "$PROJECT_NAME" ]]; then
  exit 0
fi

# Extract tool name for logging
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // .toolName // "unknown"' 2>/dev/null || echo "unknown")

# Send approval request to bridge (long timeout - waiting for human response)
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$HOOK_INPUT" \
  "http://127.0.0.1:${BRIDGE_PORT}/approve/${PROJECT_NAME}/claude" \
  --max-time 120 2>/dev/null || echo '{"approved": true}')

# Parse response
APPROVED=$(echo "$RESPONSE" | jq -r '.approved // true' 2>/dev/null || echo "true")

if [[ "$APPROVED" == "true" ]]; then
  exit 0
else
  # Exit 2 = deny the tool use
  exit 2
fi
