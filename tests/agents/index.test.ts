/**
 * Tests for the default agent registry
 */

import { createAgentRegistry } from '../../src/agents/index.js';

describe('createAgentRegistry', () => {
  it('registers codex adapter', () => {
    const registry = createAgentRegistry();
    expect(registry.get('codex')).toBeDefined();
  });
});

