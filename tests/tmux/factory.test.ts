import { describe, expect, it, vi } from 'vitest';
import { createTmuxManager, resolveTmuxSshTarget } from '../../src/tmux/factory.js';

describe('resolveTmuxSshTarget', () => {
  it('keeps raw target when no inline port exists', () => {
    const resolved = resolveTmuxSshTarget('user@host');
    expect(resolved).toEqual({ target: 'user@host' });
  });

  it('extracts inline :port suffix when explicit port is omitted', () => {
    const resolved = resolveTmuxSshTarget('user@host:2222');
    expect(resolved).toEqual({ target: 'user@host', port: 2222 });
  });

  it('prioritizes explicit port over inline target suffix', () => {
    const resolved = resolveTmuxSshTarget('user@host:2222', 2201);
    expect(resolved).toEqual({ target: 'user@host:2222', port: 2201 });
  });
});

describe('createTmuxManager', () => {
  it('throws when ssh transport is configured without a target', () => {
    expect(() =>
      createTmuxManager({
        tmux: {
          sessionPrefix: 'agent-',
          transport: 'ssh',
        },
      } as any),
    ).toThrow(/no ssh target is configured/);
  });

  it('creates manager when ssh transport has a target', () => {
    const tmux = createTmuxManager({
      tmux: {
        sessionPrefix: 'agent-',
        transport: 'ssh',
        sshTarget: 'user@host',
        sshPort: 2222,
      },
    } as any);
    expect(tmux).toBeDefined();
  });

  it('uses injected executor when provided', () => {
    const mockExecutor = {
      exec: vi.fn().mockReturnValue(''),
      execVoid: vi.fn(),
    };
    const tmux = createTmuxManager(
      {
        tmux: {
          sessionPrefix: 'agent-',
        },
      } as any,
      mockExecutor as any,
    );

    tmux.listSessions();

    expect(mockExecutor.exec).toHaveBeenCalledOnce();
    expect(String(mockExecutor.exec.mock.calls[0]?.[0] || '')).toContain('tmux list-sessions');
  });

  it('creates local manager by default', () => {
    const tmux = createTmuxManager({
      tmux: {
        sessionPrefix: 'agent-',
      },
    } as any);
    expect(tmux).toBeDefined();
  });
});
