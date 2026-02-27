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
    sendLongOutput: vi.fn().mockResolvedValue(undefined),
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
    getPendingChannel: vi.fn().mockReturnValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('BridgeCapturePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS;
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'answer from codex');
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // Without a pending request, completion should not be attempted.
    await vi.advanceTimersByTimeAsync(500);
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('formats multiline delta output for discord', async () => {
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
      'boot line\nline one\nline two',
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
    await vi.advanceTimersByTimeAsync(500);

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'line one\nline two');

    poller.stop();
  });

  it('uses discord long-output threading helper for oversized deltas', async () => {
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
    const longOutput = 'y'.repeat(2400);
    const tmux = createTmux([
      'boot line',
      `boot line\n${longOutput}`,
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
    await vi.advanceTimersByTimeAsync(500);

    expect(messaging.sendLongOutput).toHaveBeenCalledWith('ch-1', longOutput);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('prefers pending message channel for output delivery', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nthread reply',
    ]);
    const pendingTracker = createPendingTracker();
    pendingTracker.getPendingChannel.mockReturnValue('thread-ch');

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(pendingTracker.getPendingChannel).toHaveBeenCalledWith('demo', 'codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'thread reply');

    poller.stop();
  });

  it('keeps pending route until output stays quiet for threshold polls', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nfirst chunk',
      'boot line\nfirst chunk\nsecond chunk',
    ]);

    let pendingChannel: string | undefined = 'thread-ch';
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => pendingChannel),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingChannel = undefined;
      }),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    // First output cycle
    await vi.advanceTimersByTimeAsync(300);
    // Second output cycle (still routed via pending thread)
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(1, 'thread-ch', 'first chunk');
    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(2, 'thread-ch', 'second chunk');
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // First quiet cycle should not complete yet.
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // Second quiet cycle finalizes pending state.
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');

    poller.stop();
  });

  it('falls back to default channel when multiple pending requests exist', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nreply burst-1',
      'boot line\nreply burst-1\nreply burst-2',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(2),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('parent-ch', 'reply burst-1');
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('parent-ch', 'reply burst-2');
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');

    poller.stop();
  });

  it('does not auto-complete codex pending before first output by default', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'same screen',
      'same screen',
      'same screen',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('can complete codex pending earlier when initial quiet threshold is overridden', async () => {
    process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX = '2';

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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'same screen',
      'same screen',
      'same screen',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');

    poller.stop();
  });

  it('sends staged stale-screen warnings when pending has no pane changes beyond thresholds', async () => {
    process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS = '1000';

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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'same screen',
      'same screen',
      'same screen',
      'same screen',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    // 1st timed poll: no warning yet (300ms)
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // 2nd timed poll: still below threshold (600ms)
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // 3rd timed poll: still may be below threshold (900ms from baseline)
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // 4th timed poll: stage-1 threshold exceeded (~1200ms)
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'thread-ch',
      expect.stringContaining('No screen updates'),
    );

    // Between thresholds, stage-1 must not repeat.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);

    // 7th timed poll: stage-2 threshold exceeded (~2100ms from baseline).
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(
      2,
      'thread-ch',
      expect.stringContaining('Still no screen updates'),
    );

    // Further quiet polls should not spam duplicate stage-2 warnings.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(2);

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

  it('strips codex status footer noise from capture delta', async () => {
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
        '? for shortcuts                                                                     100% context left',
        'assistant: ready',
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: ready');

    poller.stop();
  });

  it('does not drop codex output when only bottom status line anchors the redraw', async () => {
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
    const footer = 'gpt-5.3-codex xhigh · 31% left · ~/yonsei/mud/ar_xapp_v3';
    const tmux = createTmux([
      ['old view line', footer].join('\n'),
      ['assistant: render from full-screen redraw', footer].join('\n'),
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: render from full-screen redraw');

    poller.stop();
  });

  it('does not send codex footer-only percentage updates', async () => {
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
      '? for shortcuts                                                                     96% context left',
      '? for shortcuts                                                                     95% context left',
      '? for shortcuts                                                                     94% context left',
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
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('strips codex hud status lines with model profile and path', async () => {
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
        'gpt-5.3-codex xhigh · 99% left · ~/yonsei/mud/ar_xapp_v3',
        'assistant: ready on new hud',
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: ready on new hud');

    poller.stop();
  });

  it('does not send codex hud-only left percentage updates', async () => {
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
      'gpt-5.3-codex xhigh · 99% left · ~/yonsei/mud/ar_xapp_v3',
      'gpt-5.3-codex xhigh · 96% left · ~/yonsei/mud/ar_xapp_v3',
      'gpt-5.3-codex xhigh · 91% left · ~/yonsei/mud/ar_xapp_v3',
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
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('strips malformed codex footer variants and keeps real output', async () => {
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
        'rfor shortcuts            t                                                         95% context left',
        'assistant: still here',
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: still here');

    poller.stop();
  });

  it('filters pending codex input echo lines from capture delta', async () => {
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
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedPromptTail, 'assistant: answer body'].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingPromptTail: vi.fn().mockReturnValue(echoedPromptTail),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: answer body');
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('ch-1', echoedPromptTail);

    poller.stop();
  });

  it('does not complete pending on echo-only delta frames', async () => {
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
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedPromptTail].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingPromptTail: vi.fn().mockReturnValue(echoedPromptTail),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('filters exact prompt-like lines when pending depth is greater than one', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedPromptTail].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(2),
      getPendingPromptTails: vi.fn().mockReturnValue([echoedPromptTail, 'another pending tail']),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('keeps non-echo lines when pending depth is greater than one', async () => {
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
            channelId: 'parent-ch',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const nonEchoLine = `${echoedPromptTail} -> transformed by assistant`;
    const tmux = createTmux([
      'boot line',
      ['boot line', nonEchoLine].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(2),
      getPendingPromptTails: vi.fn().mockReturnValue([echoedPromptTail, 'another pending tail']),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('parent-ch', nonEchoLine);

    poller.stop();
  });

  it('keeps assistant-prefixed lines even when they include prompt text', async () => {
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
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const assistantLine = `assistant: ${echoedPromptTail} -> handled`;
    const tmux = createTmux([
      'boot line',
      ['boot line', assistantLine].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingPromptTail: vi.fn().mockReturnValue(echoedPromptTail),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', assistantLine);

    poller.stop();
  });

  it('can disable codex prompt-echo filtering via env', async () => {
    process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO = 'false';

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
    const echoedPromptTail = 'this is an intentionally long prompt suffix for pending echo filtering';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedPromptTail].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingPromptTail: vi.fn().mockReturnValue(echoedPromptTail),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', echoedPromptTail);

    poller.stop();
  });

  it('falls back to sending delta after repeated prompt-echo suppressions', async () => {
    process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS = '2';

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
    const echoedLine1 = 'this is an intentionally long prompt suffix for pending echo filtering frame one 1234567890';
    const echoedLine2 = 'this is an intentionally long prompt suffix for pending echo filtering frame two 1234567890';
    const echoedLine3 = 'this is an intentionally long prompt suffix for pending echo filtering frame three 1234567890';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedLine1].join('\n'),
      ['boot line', echoedLine2].join('\n'),
      ['boot line', echoedLine3].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(2),
      getPendingPromptTails: vi.fn().mockReturnValue([echoedLine1, echoedLine2, echoedLine3]),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', echoedLine3);

    poller.stop();
  });
});
