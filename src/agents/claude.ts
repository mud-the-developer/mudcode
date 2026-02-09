/**
 * Claude Code agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const claudeConfig: AgentConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  channelSuffix: 'claude',
};

export class ClaudeAdapter extends BaseAgentAdapter {
  constructor() {
    super(claudeConfig);
  }

  getStartCommand(projectPath: string, yolo = false, sandbox = false): string {
    let flags = '';
    if (sandbox) flags += ' --sandbox';
    if (yolo) flags += ' --dangerously-skip-permissions';
    return `cd "${projectPath}" && ${this.config.command}${flags}`;
  }
}

export const claudeAdapter = new ClaudeAdapter();
