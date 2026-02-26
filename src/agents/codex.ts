/**
 * OpenAI Codex CLI agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const DEFAULT_CODEX_FLAGS = '-a on-request -s danger-full-access';

const codexConfig: AgentConfig = {
  name: 'codex',
  displayName: 'OpenAI Codex CLI',
  command: 'codex',
  channelSuffix: 'codex',
};

export class CodexAdapter extends BaseAgentAdapter {
  constructor() {
    super(codexConfig);
  }

  getStartCommand(projectPath: string): string {
    // Default to non-blocking approvals with unrestricted sandbox mode for Codex.
    // Override via MUDCODE_CODEX_FLAGS (set empty string to disable).
    const configuredFlags = process.env.MUDCODE_CODEX_FLAGS;
    const flags = configuredFlags === undefined ? DEFAULT_CODEX_FLAGS : configuredFlags.trim();
    const suffix = flags.length > 0 ? ` ${flags}` : '';
    return `cd "${projectPath}" && ${this.config.command}${suffix}`;
  }
}

export const codexAdapter = new CodexAdapter();
