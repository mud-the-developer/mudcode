/**
 * Agent adapters registry
 */

export * from './base.js';
export { claudeAdapter, ClaudeAdapter } from './claude.js';
export { opencodeAdapter, OpenCodeAdapter } from './opencode.js';
export { codexAdapter, CodexAdapter } from './codex.js';

import { agentRegistry } from './base.js';
import { claudeAdapter } from './claude.js';
import { opencodeAdapter } from './opencode.js';
import { codexAdapter } from './codex.js';

// Register all available agents
agentRegistry.register(claudeAdapter);
agentRegistry.register(opencodeAdapter);
agentRegistry.register(codexAdapter);

export { agentRegistry };
