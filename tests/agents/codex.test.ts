/**
 * Tests for CodexAdapter
 */

import { CodexAdapter } from '../../src/agents/codex.js';

describe('CodexAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new CodexAdapter();

    expect(adapter.config.name).toBe('codex');
    expect(adapter.config.displayName).toBe('OpenAI Codex CLI');
    expect(adapter.config.command).toBe('codex');
    expect(adapter.config.channelSuffix).toBe('codex');
  });

  it('should return expected start command', () => {
    const adapter = new CodexAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && codex');
  });
});
