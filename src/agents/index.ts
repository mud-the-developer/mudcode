/**
 * Agent adapters registry
 */

export * from './base.js';
export { claudeAdapter, ClaudeAdapter } from './claude.js';
export { codexAdapter, CodexAdapter } from './codex.js';
export { opencodeAdapter, OpenCodeAdapter } from './opencode.js';

import { AgentRegistry } from './base.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';

/**
 * Create a new AgentRegistry with all default adapters registered
 */
export function createAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(claudeAdapter);
  registry.register(codexAdapter);
  registry.register(opencodeAdapter);
  return registry;
}

// Default singleton for backward compatibility
export const agentRegistry = createAgentRegistry();
