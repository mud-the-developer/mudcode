/**
 * OpenCode CLI agent adapter
 * https://opencode.ai/
 */

import { BaseAgentAdapter, HookData, AgentConfig } from './base.js';

const opencodeConfig: AgentConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  command: 'opencode',
  hookEndpoint: 'opencode',
  channelSuffix: 'opencode',
};

export class OpenCodeAdapter extends BaseAgentAdapter {
  constructor() {
    super(opencodeConfig);
  }

  formatHookOutput(hookData: HookData): string {
    const toolName = hookData.tool_name || hookData.toolName || hookData.tool || 'unknown';
    let output = hookData.tool_response || hookData.output || hookData.result || '';

    if (typeof output === 'object') {
      output = JSON.stringify(output, null, 2);
    }

    const maxLength = 1800;
    const truncatedOutput =
      output.length > maxLength ? output.substring(0, maxLength) + '\n... (truncated)' : output;

    return `**OpenCode** - 🟢 ${toolName}\n\`\`\`\n${truncatedOutput}\n\`\`\``;
  }

  getHookScript(bridgePort: number): string {
    return `#!/usr/bin/env bash
# OpenCode PostToolUse hook for discord-agent-bridge
# This plugin script sends tool outputs to the bridge server

BRIDGE_PORT="\${AGENT_DISCORD_PORT:-${bridgePort}}"
PROJECT_NAME="\${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Send to bridge if project is configured
if [[ -n "$PROJECT_NAME" ]]; then
  curl -s -X POST \\
    -H "Content-Type: application/json" \\
    -d "$HOOK_INPUT" \\
    "http://127.0.0.1:\${BRIDGE_PORT}/hook/\${PROJECT_NAME}/opencode" \\
    --max-time 2 >/dev/null 2>&1 || true
fi

echo '{"status": "ok"}'
`;
  }

  getHookInstallPath(): string {
    return 'opencode.json';
  }

  getSettingsConfig(_hookScriptPath: string): object {
    return {
      _note: 'OpenCode uses a plugin system. Place plugin in .opencode/plugins/',
      plugins: {
        'discord-bridge': { enabled: true },
      },
    };
  }
}

export const opencodeAdapter = new OpenCodeAdapter();
