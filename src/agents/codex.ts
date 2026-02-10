/**
 * Codex CLI agent adapter
 *
 * Assumes the Codex CLI is available as `codex` on PATH.
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const codexConfig: AgentConfig = {
  name: 'codex',
  displayName: 'Codex',
  command: 'codex',
  channelSuffix: 'codex',
};

export class CodexAdapter extends BaseAgentAdapter {
  constructor() {
    super(codexConfig);
  }
}

export const codexAdapter = new CodexAdapter();

