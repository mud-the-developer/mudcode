/**
 * OpenAI Codex CLI agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

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
}

export const codexAdapter = new CodexAdapter();
