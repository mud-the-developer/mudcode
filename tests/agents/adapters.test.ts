/**
 * Tests for OpenCodeAdapter
 */

import { OpenCodeAdapter } from '../../src/agents/opencode.js';

describe('OpenCodeAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new OpenCodeAdapter();

    expect(adapter.config.name).toBe('opencode');
    expect(adapter.config.displayName).toBe('OpenCode');
    expect(adapter.config.command).toBe('opencode');
    expect(adapter.config.channelSuffix).toBe('opencode');
  });

  it('should return expected start command', () => {
    const adapter = new OpenCodeAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && opencode');
  });
});
