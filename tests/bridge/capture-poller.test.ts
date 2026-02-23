import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeCapturePoller } from '../../src/bridge/capture-poller.js';

function createStateManager(projects: any[]) {
  return {
    listProjects: vi.fn().mockReturnValue(projects),
  } as any;
}

function createMessaging(platform: 'discord' | 'slack' = 'discord') {
  return {
    platform,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createTmux(captures: string[]) {
  const queue = [...captures];
  return {
    capturePaneFromWindow: vi.fn().mockImplementation(() => queue.shift() ?? queue[queue.length - 1] ?? ''),
  } as any;
}

function createPendingTracker() {
  return {
    markCompleted: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('BridgeCapturePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends delta output for non-hook instances', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nanswer from codex',
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
    });

    poller.start();
    await Promise.resolve();

    // First snapshot is baseline only.
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'answer from codex');

    poller.stop();
  });

  it('does not poll instances that already have event hooks', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'demo-claude',
            channelId: 'ch-1',
            eventHook: true,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux(['ignored']);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1200);

    expect(tmux.capturePaneFromWindow).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('handles capture overlap after pane reset/truncation', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'line1\nline2\nline3',
      'line3\nline4',
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'line4');

    poller.stop();
  });

  it('strips codex bootstrap shell noise from fallback capture delta', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      [
        'boot line',
        "export AGENT_DISCORD_PROJECT='demo'; export AGENT_DISCORD_PORT='18470'; export AGENT_DISCORD_AGENT='codex'; cd \"/tmp/demo\" && codex",
        'assistant: done',
      ].join('\n'),
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: done');

    poller.stop();
  });
});
