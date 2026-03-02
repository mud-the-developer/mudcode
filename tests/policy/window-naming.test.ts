import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../../src/types/index.js';
import {
  buildRandomChannelInstanceName,
  resolveProjectWindowName,
  toProjectScopedChannelName,
  toProjectScopedName,
  toSharedWindowName,
} from '../../src/policy/window-naming.js';

function createProject(overrides?: Partial<ProjectState>): ProjectState {
  return {
    projectName: 'my-project',
    projectPath: '/tmp/project',
    tmuxSession: 'agent-bridge',
    agents: { claude: true },
    discordChannels: { claude: 'ch-1' },
    createdAt: new Date(),
    lastActive: new Date(),
    ...overrides,
  };
}

describe('window naming policy', () => {
  it('builds shared window names with sanitization', () => {
    expect(toSharedWindowName('my project', 'claude:2')).toBe('my-project-claude-2');
  });

  it('builds project-scoped name from base + instance', () => {
    expect(toProjectScopedName('my-project', 'claude', 'claude')).toBe('my-project-claude');
    expect(toProjectScopedName('my-project', 'claude', 'claude-2')).toBe('my-project-claude-2');
    expect(toProjectScopedName('my-project', 'claude', '2')).toBe('my-project-claude-2');
  });

  it('builds project-scoped channel name with random instance suffix', () => {
    const name = toProjectScopedChannelName('my-project', 'claude', 'claude-2', 'AbC_123');
    expect(name).toBe('my-project-claude-2-abc123');
  });

  it('preserves random suffix when clipping long channel names', () => {
    const name = toProjectScopedChannelName(
      'very-long-project-name-that-keeps-going-for-channel-name-tests',
      'claude',
      'claude-2',
      'zz99yy',
      32,
    );
    expect(name.endsWith('-zz99yy')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
  });

  it('creates random channel instance tokens', () => {
    const token = buildRandomChannelInstanceName();
    expect(token).toMatch(/^[a-z0-9]{6}$/);
  });

  it('resolves mapped window first, then shared-session fallback', () => {
    const mapped = createProject({
      instances: {
        claude: {
          instanceId: 'claude',
          agentType: 'claude',
          tmuxWindow: 'explicit-window',
        },
      },
    });
    expect(resolveProjectWindowName(mapped, 'claude', { sessionPrefix: 'agent-', sharedSessionName: 'bridge' }, 'claude'))
      .toBe('explicit-window');

    const shared = createProject({
      instances: {
        'claude-2': {
          instanceId: 'claude-2',
          agentType: 'claude',
        },
      },
    });
    expect(resolveProjectWindowName(shared, 'claude', { sessionPrefix: 'agent-', sharedSessionName: 'bridge' }, 'claude-2'))
      .toBe('my-project-claude-2');
  });
});
