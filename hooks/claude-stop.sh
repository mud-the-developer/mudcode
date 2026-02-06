#!/usr/bin/env bash
# Claude Code Stop hook
# Captures Claude's final text response from transcript and sends to Discord

set -euo pipefail

# Configuration
BRIDGE_PORT="${AGENT_DISCORD_PORT:-18470}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Debug log
LOG="/tmp/claude-stop-debug.log"
echo "[stop-hook] $(date) PORT=$BRIDGE_PORT PROJ=$PROJECT_NAME" >> "$LOG"

# Read hook input from stdin
HOOK_INPUT=$(cat)
echo "[stop-hook] INPUT=${HOOK_INPUT:0:300}" >> "$LOG"

# Skip if project not configured
if [[ -z "$PROJECT_NAME" ]]; then
  echo "[stop-hook] SKIP: no project" >> "$LOG"
  exit 0
fi

# Extract transcript path from hook input
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
echo "[stop-hook] TRANSCRIPT=$TRANSCRIPT_PATH" >> "$LOG"

if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "[stop-hook] SKIP: no transcript file" >> "$LOG"
  exit 0
fi

# Extract the last assistant message's text content from JSONL transcript
# tail -50 to avoid reading huge files; jq -s slurps lines into array
LAST_RESPONSE=$(tail -50 "$TRANSCRIPT_PATH" | jq -s -r '
  [.[] | select(.type == "assistant")] | last // null |
  if . then
    [.message.content[] | select(.type == "text") | .text] | join("\n")
  else
    ""
  end
' 2>/dev/null || echo "")

echo "[stop-hook] RESPONSE_LEN=${#LAST_RESPONSE}" >> "$LOG"
echo "[stop-hook] RESPONSE_PREVIEW=${LAST_RESPONSE:0:100}" >> "$LOG"

# Skip if no text response (tool-only turn)
if [[ -z "$LAST_RESPONSE" ]]; then
  echo "[stop-hook] SKIP: empty response" >> "$LOG"
  exit 0
fi

# Only notify for completion messages (filter out intermediate responses)
COMPLETION_PATTERN='완료|끝|마쳤|했습니다|됩니다|done|complete|finish|fixed|implement'
if ! echo "$LAST_RESPONSE" | grep -qiE "$COMPLETION_PATTERN"; then
  echo "[stop-hook] SKIP: not a completion message" >> "$LOG"
  exit 0
fi

# Truncate for Discord (2000 char limit, leave room for header)
MAX_LEN=1900
if [[ ${#LAST_RESPONSE} -gt $MAX_LEN ]]; then
  LAST_RESPONSE="${LAST_RESPONSE:0:$MAX_LEN}..."
fi

# Send to Discord via bridge notify endpoint
PAYLOAD=$(jq -n --arg msg "$LAST_RESPONSE" '{message: ("💬 " + $msg)}')
CURL_RESULT=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "http://127.0.0.1:${BRIDGE_PORT}/notify/${PROJECT_NAME}/claude" \
  --max-time 5 2>&1 || echo "CURL_FAILED:$?")
echo "[stop-hook] CURL: $CURL_RESULT" >> "$LOG"

exit 0
