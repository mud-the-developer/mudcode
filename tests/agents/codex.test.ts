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

    expect(command).toBe('cd "/path/to/project" && codex --no-alt-screen -a on-request -s danger-full-access');
  });

  it('allows overriding codex flags via environment variable', () => {
    const adapter = new CodexAdapter();
    const previousFlags = process.env.MUDCODE_CODEX_FLAGS;
    try {
      process.env.MUDCODE_CODEX_FLAGS = '-a never -s danger-full-access';

      const command = adapter.getStartCommand('/path/to/project');

      expect(command).toBe('cd "/path/to/project" && codex -a never -s danger-full-access');
    } finally {
      process.env.MUDCODE_CODEX_FLAGS = previousFlags;
    }
  });

  it('allows disabling extra codex flags via environment variable', () => {
    const adapter = new CodexAdapter();
    const previousFlags = process.env.MUDCODE_CODEX_FLAGS;
    try {
      process.env.MUDCODE_CODEX_FLAGS = '';

      const command = adapter.getStartCommand('/path/to/project');

      expect(command).toBe('cd "/path/to/project" && codex');
    } finally {
      process.env.MUDCODE_CODEX_FLAGS = previousFlags;
    }
  });
});
