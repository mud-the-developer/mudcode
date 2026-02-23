import { describe, expect, it, vi } from 'vitest';
import { BridgeMessageRouter } from '../../src/bridge/message-router.js';

function createProjectState() {
  const now = new Date();
  return {
    projectName: 'demo',
    projectPath: '/tmp/demo',
    tmuxSession: 'agent-demo',
    agents: { codex: true },
    discordChannels: { codex: 'ch-1' },
    createdAt: now,
    lastActive: now,
    instances: {
      codex: {
        instanceId: 'codex',
        agentType: 'codex',
        tmuxWindow: 'demo-codex',
        channelId: 'ch-1',
        eventHook: false,
      },
    },
  };
}

function createMessagingMock() {
  let callback: any;
  return {
    messaging: {
      platform: 'discord',
      onMessage: vi.fn((cb) => {
        callback = cb;
      }),
      sendToChannel: vi.fn().mockResolvedValue(undefined),
    } as any,
    getCallback: () => callback,
  };
}

describe('BridgeMessageRouter (codex)', () => {
  it('relaunches codex instead of sending prompt when pane is at shell', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('zsh'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(tmux.sendKeysToWindow).not.toHaveBeenCalled();
    expect(pendingTracker.markError).toHaveBeenCalledWith('demo', 'codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('relaunched `codex`'),
    );
  });

  it('submits prompt to codex pane when codex is active', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello codex', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'hello codex', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markError).not.toHaveBeenCalled();
  });
});
