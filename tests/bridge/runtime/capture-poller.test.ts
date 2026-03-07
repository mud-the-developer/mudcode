import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeCapturePoller } from '../../../src/bridge/runtime/capture-poller.js';

function createStateManager(projects: any[]) {
  return {
    listProjects: vi.fn().mockReturnValue(projects),
  } as any;
}

function createMessaging(platform: 'discord' | 'slack' = 'discord') {
  return {
    platform,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToProgressThread: vi.fn().mockResolvedValue(undefined),
    sendLongOutput: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createTmux(captures: string[]) {
  const queue = [...captures];
  return {
    capturePaneFromWindow: vi.fn().mockImplementation(() => queue.shift() ?? queue[queue.length - 1] ?? ''),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
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
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '0';
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_DEDUPE_WINDOW_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_ENABLED;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_MAX_CHARS;
    delete process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_AUTO_RECOVER;
    delete process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES;
    delete process.env.AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_MAX_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_BACKOFF_MAX_STEPS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_STREAMING;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_WINDOW_MS;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN;
    delete process.env.AGENT_DISCORD_SUPERVISOR_FINAL_REQUIRE_EVIDENCE;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_DEAD_WORKER_MISSING_POLLS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX;
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_DEDUPE_WINDOW_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_ENABLED;
    delete process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_MAX_CHARS;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS;
    delete process.env.AGENT_DISCORD_CAPTURE_STALE_AUTO_RECOVER;
    delete process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES;
    delete process.env.AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_MAX_POLLS;
    delete process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_BACKOFF_MAX_STEPS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_STREAMING;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_WINDOW_MS;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN;
    delete process.env.AGENT_DISCORD_SUPERVISOR_FINAL_REQUIRE_EVIDENCE;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_DEAD_WORKER_MISSING_POLLS;
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

  it('skips idle codex capture polls when baseline exists and there is no pending work', async () => {
    process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS = '2';
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
      'boot line\nidle refresh delta',
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
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'idle refresh delta');

    poller.stop();
  });

  it('expands idle refresh interval with adaptive backoff under sustained idle', async () => {
    process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS = '1';
    process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_MAX_POLLS = '3';
    process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_BACKOFF_MAX_STEPS = '6';
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
      'boot line\nrefresh-1',
      'boot line\nrefresh-2',
      'boot line\nrefresh-3',
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
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(1);

    // Base idle threshold=1 -> capture on second tick.
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'refresh-1');

    // Backoff raises threshold to 2 -> capture on third tick.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(3);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'refresh-2');

    // Backoff raises threshold to 3 (max) -> capture on fourth tick.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(4);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'refresh-3');

    poller.stop();
  });

  it('skips idle polls for hidden orchestrator workers with no pending work', async () => {
    process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS = '2';
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            eventHook: false,
          },
          'codex-2': {
            instanceId: 'codex-2',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-2',
            channelId: 'ch-worker',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = {
      capturePaneFromWindow: vi
        .fn()
        .mockImplementation((_session: string, targetWindow: string) =>
          targetWindow.includes('codex-2') ? 'boot line\nworker hidden delta' : 'supervisor idle',
        ),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      windowExists: vi.fn().mockReturnValue(true),
    } as any;
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(tmux.capturePaneFromWindow).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('ch-worker', expect.any(String));

    poller.stop();
  });

  it('routes progress deltas to thread output when visibility gate is thread', async () => {
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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nprogress chunk',
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
      progressOutputVisibility: 'thread',
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(messaging.sendToProgressThread).toHaveBeenCalledWith('ch-1', 'progress chunk');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('flushes non-codex pending capture output on quiet snapshot events', async () => {
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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nchunk one',
      'boot line\nchunk one',
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
      intervalMs: 500,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(500);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'chunk one');

    poller.stop();
  });

  it('captures pending output even when instance channel mapping is missing', async () => {
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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\npending route delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('pending-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

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
    await vi.advanceTimersByTimeAsync(500);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('pending-ch', 'pending route delta');

    poller.stop();
  });

  it('suppresses progress deltas when visibility gate is off', async () => {
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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nprogress chunk',
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
      progressOutputVisibility: 'off',
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(messaging.sendToProgressThread).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('suppresses duplicate progress output only inside the dedupe window', async () => {
    process.env.AGENT_DISCORD_CAPTURE_PROGRESS_DEDUPE_WINDOW_MS = '800';

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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nduplicate progress',
      'boot line\nduplicate progress\nduplicate progress',
      'boot line\nduplicate progress\nduplicate progress',
      'boot line\nduplicate progress\nduplicate progress\nduplicate progress',
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
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenLastCalledWith('ch-1', 'duplicate progress');

    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(2, 'ch-1', 'duplicate progress');

    poller.stop();
  });

  it('accumulates progress batch and flushes once on quiet poll', async () => {
    process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_ENABLED = '1';
    process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_MAX_CHARS = '12000';

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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nbatch first',
      'boot line\nbatch first\nbatch second',
      'boot line\nbatch first\nbatch second',
      'boot line\nbatch first\nbatch second',
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
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'batch first\nbatch second');

    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('emits batched progress via force+quiet flush when pending depth drops to zero', async () => {
    process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_ENABLED = '1';
    process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_MAX_CHARS = '12000';

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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nforce flush chunk',
      'boot line\nforce flush chunk',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
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

    pendingDepth = 0;
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'force flush chunk');

    poller.stop();
  });

  it('suppresses worker output in capture fallback when orchestrator visibility is hidden', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
        instances: {
          'codex-2': {
            instanceId: 'codex-2',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-2',
            channelId: 'ch-2',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nworker progress',
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

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(messaging.sendToProgressThread).not.toHaveBeenCalled();

    poller.stop();
  });

  it('routes worker output to progress thread when orchestrator visibility is thread', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'thread',
        },
        instances: {
          'codex-2': {
            instanceId: 'codex-2',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-2',
            channelId: 'ch-2',
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nworker progress',
    ]);
    const pendingTracker = createPendingTracker();

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 500,
      progressOutputVisibility: 'off',
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);

    expect(messaging.sendToProgressThread).toHaveBeenCalledWith('ch-2', 'worker progress');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

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

  it('buffers codex deltas and sends once when request completes in final-only mode by default', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

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
      'boot line\nstep one',
      'boot line\nstep one\nstep two',
      'boot line\nstep one\nstep two',
      'boot line\nstep one\nstep two',
      'boot line\nstep one\nstep two\nstep three',
      'boot line\nstep one\nstep two\nstep three',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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

    // Two output polls: buffered only, no immediate send.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Two quiet polls trigger completion only.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Trailing redraw delta after completion is still buffered.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // First quiet poll after pending completion still waits in final-only mode.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Next quiet poll flushes buffered output once.
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'step one\nstep two\nstep three');

    poller.stop();
  });

  it('applies char-budget truncation for final-only buffered output', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;
    process.env.AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS = '4000';

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
    const lineOne = `line-1 ${'A'.repeat(1900)}`;
    const lineTwo = `line-2 ${'B'.repeat(1900)}`;
    const lineThree = `line-3 ${'C'.repeat(1900)}`;
    const tmux = createTmux([
      'boot line',
      `boot line\n${lineOne}`,
      `boot line\n${lineOne}\n${lineTwo}`,
      `boot line\n${lineOne}\n${lineTwo}`,
      `boot line\n${lineOne}\n${lineTwo}`,
      `boot line\n${lineOne}\n${lineTwo}\n${lineThree}`,
      `boot line\n${lineOne}\n${lineTwo}\n${lineThree}`,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(messaging.sendLongOutput).toHaveBeenCalledTimes(1);
    const delivered = String(messaging.sendLongOutput.mock.calls[0]?.[1] ?? '');
    expect(delivered).toContain('[truncated by final-output buffer gate]');
    expect(delivered).toContain('line-3');
    expect(delivered).not.toContain('line-1');

    poller.stop();
  });

  it('emits codex session.final hook on final-only flush when hook client is enabled', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> emit final hook

    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'demo',
        instanceId: 'codex',
        turnId: 'msg-1',
        channelId: 'thread-ch',
        text: 'assistant: step one',
      }),
    );
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('requests supervisor final-format retry when orchestrator policy is enabled and output is non-compliant', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

    const longUnstructured = `assistant: ${'x'.repeat(520)}`;
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerFinalVisibility: 'hidden',
          supervisorFinalFormat: {
            enforce: true,
            maxRetries: 1,
          },
        },
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
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-super-format-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
      markPending: vi.fn().mockImplementation(async () => {
        pendingDepth = 1;
      }),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
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

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> markCompleted
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #1
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #2 -> request retry

    expect(pendingTracker.markPending).toHaveBeenCalledTimes(1);
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex',
      expect.stringContaining('[mudcode supervisor-final-format]'),
      'codex',
    );
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'thread-ch',
      expect.stringContaining('Supervisor final-format retry 1/1 requested'),
    );

    poller.stop();
  });

  it('requests supervisor final-format retry when headings exist but evidence is missing', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

    const structuredButNoEvidence = [
      '1) Need your check',
      'none',
      '2) Changes',
      'updated internals',
      '3) Verification',
      'looks good',
    ].join('\n');
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerFinalVisibility: 'hidden',
          supervisorFinalFormat: {
            enforce: true,
            maxRetries: 1,
          },
        },
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
      `boot line\n${structuredButNoEvidence}`,
      `boot line\n${structuredButNoEvidence}`,
      `boot line\n${structuredButNoEvidence}`,
      `boot line\n${structuredButNoEvidence}`,
      `boot line\n${structuredButNoEvidence}`,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-super-format-evidence-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
      markPending: vi.fn().mockImplementation(async () => {
        pendingDepth = 1;
      }),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
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
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(pendingTracker.markPending).toHaveBeenCalledTimes(1);
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex',
      expect.stringContaining('[mudcode supervisor-final-format]'),
      'codex',
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'thread-ch',
      expect.stringContaining('Supervisor final-format retry 1/1 requested'),
    );

    poller.stop();
  });

  it('accepts supervisor final-format output when file and verification evidence exist', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

    const compliantWithEvidence = [
      '1) Need your check',
      'none',
      '2) Changes',
      '- src/bridge/runtime/message-router.ts: delegation-contract gate',
      '3) Verification',
      '- `bun run test tests/bridge/runtime/message-router.test.ts` pass',
    ].join('\n');
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerFinalVisibility: 'hidden',
          supervisorFinalFormat: {
            enforce: true,
            maxRetries: 1,
          },
        },
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
      `boot line\n${compliantWithEvidence}`,
      `boot line\n${compliantWithEvidence}`,
      `boot line\n${compliantWithEvidence}`,
      `boot line\n${compliantWithEvidence}`,
      `boot line\n${compliantWithEvidence}`,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-super-format-evidence-2' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
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
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(pendingTracker.markPending).not.toHaveBeenCalled();
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', compliantWithEvidence);

    poller.stop();
  });

  it('falls back to sending latest output when supervisor final-format retries are exhausted', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

    const longUnstructured = `assistant: ${'y'.repeat(520)}`;
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerFinalVisibility: 'hidden',
          supervisorFinalFormat: {
            enforce: true,
            maxRetries: 0,
          },
        },
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
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
      `boot line\n${longUnstructured}`,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-super-format-2' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> markCompleted
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #1
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #2 -> fallback send

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'thread-ch',
      expect.stringContaining('retries exhausted (0)'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', longUnstructured);

    poller.stop();
  });

  it('emits throttled codex session.progress hook while output is still streaming', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE = 'thread';
    process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_STREAMING = '1';
    process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_WINDOW_MS = '320';
    process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_MAX_CHARS = '1700';

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one\nassistant: step two',
    ]);

    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-progress-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(1);
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-progress-1',
      channelId: 'thread-ch',
      text: 'assistant: step one',
      progressMode: 'thread',
      progressBlockStreaming: true,
      progressBlockWindowMs: 320,
      progressBlockMaxChars: 1700,
    });

    poller.stop();
  });

  it('suppresses codex progress hook burst emissions after per-turn max', async () => {
    process.env.AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN = '2';

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
      'boot line\nassistant: burst step one',
      'boot line\nassistant: burst step one\nassistant: burst step two',
      'boot line\nassistant: burst step one\nassistant: burst step two\nassistant: burst step three',
      'boot line\nassistant: burst step one\nassistant: burst step two\nassistant: burst step three\nassistant: burst step four',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-burst-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 600,
      codexProgressHookMinIntervalMs: 500,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(600);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(2);
    expect(eventHookClient.emitCodexProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ turnId: 'msg-burst-1', text: 'assistant: burst step one' }),
    );
    expect(eventHookClient.emitCodexProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ turnId: 'msg-burst-1', text: 'assistant: burst step two' }),
    );

    poller.stop();
  });

  it('resets codex progress hook burst suppression when pending turn changes', async () => {
    process.env.AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN = '2';

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
      'boot line\nassistant: turn a one',
      'boot line\nassistant: turn a one\nassistant: turn a two',
      'boot line\nassistant: turn a one\nassistant: turn a two\nassistant: turn a three',
      'boot line\nassistant: turn a one\nassistant: turn a two\nassistant: turn a three\nassistant: turn b one',
      'boot line\nassistant: turn a one\nassistant: turn a two\nassistant: turn a three\nassistant: turn b one\nassistant: turn b two',
    ]);
    let turnId = 'msg-burst-turn-a';
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockImplementation(() => turnId),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 600,
      codexProgressHookMinIntervalMs: 500,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600); // turn-a emit #1
    await vi.advanceTimersByTimeAsync(600); // turn-a emit #2
    await vi.advanceTimersByTimeAsync(600); // turn-a suppressed
    turnId = 'msg-burst-turn-b';
    await vi.advanceTimersByTimeAsync(600); // turn-b emit #1
    await vi.advanceTimersByTimeAsync(600); // turn-b emit #2

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(4);
    expect(
      eventHookClient.emitCodexProgress.mock.calls.map((call: any[]) => call[0]?.turnId),
    ).toEqual(['msg-burst-turn-a', 'msg-burst-turn-a', 'msg-burst-turn-b', 'msg-burst-turn-b']);

    poller.stop();
  });

  it('applies orchestrator progress policy directives to codex progress hook events', async () => {
    const stateManager = createStateManager([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: [],
          progressPolicy: {
            byChannelId: {
              'thread-ch': {
                mode: 'thread',
                blockStreamingEnabled: false,
                blockWindowMs: 777,
                blockMaxChars: 1600,
              },
            },
          },
        },
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
      'boot line\nassistant: policy delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-progress-policy-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-progress-policy-1',
      channelId: 'thread-ch',
      text: 'assistant: policy delta',
      progressMode: 'thread',
      progressBlockStreaming: false,
      progressBlockWindowMs: 777,
      progressBlockMaxChars: 1600,
    });

    poller.stop();
  });

  it('suppresses direct codex progress delivery and routes through hook events', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '0';

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
      'boot line\nassistant: step one',
    ]);

    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-event-only-progress-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(1);
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-event-only-progress-1',
      channelId: 'thread-ch',
      text: 'assistant: step one',
    });
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('emits codex session.final lifecycle event even without final-only buffering', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '0';

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-event-only-final-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(300); // output observed via progress event only
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> emit final lifecycle

    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'demo',
        instanceId: 'codex',
        turnId: 'msg-event-only-final-1',
        channelId: 'thread-ch',
        text: 'assistant: step one',
      }),
    );
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not fall back to direct channel output when codex final hook fails by default', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-event-only-fail-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(false),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> markCompleted
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #1
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #2 -> attempt final hook (fails)

    expect(eventHookClient.emitCodexFinal).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('keeps codex final output event-driven when the final hook accepts the payload', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-event-only-final-accepted-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> markCompleted
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #1
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #2 -> final hook (succeeds)

    expect(eventHookClient.emitCodexFinal).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not fall back to direct channel output when codex final hook fails even with legacy env opt-in', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;
    process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT = '0';

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      getPendingMessageId: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'msg-event-only-fail-opt-in-1' : undefined)),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
      }),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(false),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(300); // output buffered
    await vi.advanceTimersByTimeAsync(300); // quiet #1 while pending
    await vi.advanceTimersByTimeAsync(300); // quiet #2 -> markCompleted
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #1
    await vi.advanceTimersByTimeAsync(300); // final-only flush quiet #2 -> attempt final hook (fails)

    expect(eventHookClient.emitCodexFinal).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('thread-ch', expect.stringContaining('step one'));
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('emits codex session.final at most once per turn in event mode even if late deltas arrive', async () => {
    delete process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;

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
    const footer = 'gpt-5.3-codex xhigh · 93% left · ~/repo/demo';
    const tmux = createTmux([
      'boot line',
      ['boot line', 'assistant: chunk one', '›', footer].join('\n'),
      ['boot line', 'assistant: chunk one', 'assistant: chunk two', '›', footer].join('\n'),
      ['boot line', 'assistant: chunk one', 'assistant: chunk two', '›', footer].join('\n'),
      ['boot line', 'assistant: chunk one', 'assistant: chunk two', 'assistant: chunk three', '›', footer].join('\n'),
      ['boot line', 'assistant: chunk one', 'assistant: chunk two', 'assistant: chunk three', '›', footer].join('\n'),
      ['boot line', 'assistant: chunk one', 'assistant: chunk two', 'assistant: chunk three', '›', footer].join('\n'),
    ]);

    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-event-only-once-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();

    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(eventHookClient.emitCodexFinal).toHaveBeenCalledTimes(1);
    expect(eventHookClient.emitCodexFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'demo',
        instanceId: 'codex',
        turnId: 'msg-event-only-once-1',
        channelId: 'thread-ch',
      }),
    );
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('keeps codex output on hook-event path even when legacy event-only env is disabled', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '0';
    delete process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT;

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
      'boot line\ndelta one',
    ]);

    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-force-event-output-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('thread-ch', 'delta one');

    poller.stop();
  });

  it('keeps codex output off direct channel delivery while progress hook request is still in-flight even when legacy event-only env is disabled', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '0';
    process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT = '0';

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
      'boot line\ndelta one',
    ]);

    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-progress-block-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockImplementation(() => new Promise<boolean>(() => {})),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not complete codex pending while Esc-to-interrupt marker is visible', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
    const workingFrame = [
      'boot line',
      'assistant: partial answer',
      '• Working (12s • esc to interrupt)',
    ].join('\n');
    const tmux = createTmux([
      'boot line',
      'boot line\nassistant: partial answer',
      workingFrame,
      workingFrame,
      workingFrame,
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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

    // First visible assistant output gets buffered.
    await vi.advanceTimersByTimeAsync(300);
    // Working-marker quiet polls should not complete pending.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('buffers codex output in final-only mode even when pending depth is 0 while working marker is present', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
      ['boot line', 'assistant: step one', '• Working (2s • esc to interrupt)'].join('\n'),
      ['boot line', 'assistant: step one', '• Working (3s • esc to interrupt)'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two', '• Working (4s • esc to interrupt)'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two', '›'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two', '›'].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue(undefined),
      getPendingDepth: vi.fn().mockReturnValue(0),
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

    // While working marker is visible, no output should leak.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Marker disappears; output stays buffered until quiet threshold is met.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Next quiet poll flushes buffered final content.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('parent-ch', 'assistant: step two');

    poller.stop();
  });

  it('does not leak codex progress when final-only mode is enabled and pending depth is 0', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
      ['boot line', 'assistant: step one'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two'].join('\n'),
      ['boot line', 'assistant: step one', 'assistant: step two'].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue(undefined),
      getPendingDepth: vi.fn().mockReturnValue(0),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
      progressOutputVisibility: 'thread',
    });

    poller.start();
    await Promise.resolve();

    // While output is changing, final-only mode should keep buffering.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(messaging.sendToProgressThread).not.toHaveBeenCalled();

    // First quiet poll after output change still waits.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Next quiet poll flushes consolidated final output once.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('parent-ch', 'assistant: step two');
    expect(messaging.sendToProgressThread).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not flush buffered final-only output when pending drops to 0 but working marker remains', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
      'boot line\nassistant: intro',
      ['boot line', 'assistant: intro', '• Working (5s • esc to interrupt)'].join('\n'),
      ['boot line', 'assistant: intro', '• Working (6s • esc to interrupt)'].join('\n'),
      ['boot line', 'assistant: intro', 'assistant: final', '›'].join('\n'),
      ['boot line', 'assistant: intro', 'assistant: final', '›'].join('\n'),
    ]);

    let pendingDepth = 1;
    let depthReads = 0;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => {
        depthReads += 1;
        if (depthReads >= 3) pendingDepth = 0; // simulate tracker desync/drop during processing
        return pendingDepth;
      }),
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

    await vi.advanceTimersByTimeAsync(300); // buffer intro
    await vi.advanceTimersByTimeAsync(300); // pending drops to 0 + working marker
    await vi.advanceTimersByTimeAsync(300); // still working marker
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300); // marker removed, delta buffered
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300); // first quiet poll after marker removal
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300); // second quiet poll flush

    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'assistant: final');

    poller.stop();
  });

  it('keeps buffering when pending drops to 0 during a quiet gap and flushes only after stable quiet', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
      'boot line\nassistant: step one',
      'boot line\nassistant: step one',
      'boot line\nassistant: step one\nassistant: step two',
      'boot line\nassistant: step one\nassistant: step two',
      'boot line\nassistant: step one\nassistant: step two',
    ]);

    let pendingDepth = 1;
    let depthReads = 0;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => {
        depthReads += 1;
        if (depthReads >= 3) pendingDepth = 0;
        return pendingDepth;
      }),
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

    await vi.advanceTimersByTimeAsync(300); // buffer step one
    await vi.advanceTimersByTimeAsync(300); // pending dropped to 0 during quiet gap
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300); // step two appears; must remain buffered
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300); // first quiet poll
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300); // second quiet poll flush
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'assistant: step two');

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

  it('completes codex pending quickly when input-ready marker appears', async () => {
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
    const footer = 'gpt-5.3-codex xhigh · 93% left · ~/repo/demo';
    const tmux = createTmux([
      'boot line',
      ['boot line', 'assistant: final answer ready', '›', footer].join('\n'),
      ['boot line', 'assistant: final answer ready', '›', footer].join('\n'),
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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
    expect(messaging.sendToChannel).toHaveBeenCalled();
    const firstPayload = String(messaging.sendToChannel.mock.calls[0]?.[1] ?? '');
    expect(firstPayload).toContain('assistant: final answer ready');
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // First quiet cycle should complete immediately due ready marker.
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex');

    poller.stop();
  });

  it('does not complete codex pending immediately on input-ready marker in final-only mode', async () => {
    process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY = '1';

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
    const footer = 'gpt-5.3-codex xhigh · 93% left · ~/repo/demo';
    const tmux = createTmux([
      'boot line',
      ['boot line', 'assistant: final answer ready', '›', footer].join('\n'),
      ['boot line', 'assistant: final answer ready', '›', footer].join('\n'),
      ['boot line', 'assistant: final answer ready', '›', footer].join('\n'),
    ]);

    let pendingDepth = 1;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockImplementation(() => (pendingDepth > 0 ? 'thread-ch' : undefined)),
      getPendingDepth: vi.fn().mockImplementation(() => pendingDepth),
      markCompleted: vi.fn().mockImplementation(async () => {
        pendingDepth = 0;
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

    // First output poll buffers only.
    await vi.advanceTimersByTimeAsync(300);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // Ready marker should not complete immediately in final-only mode.
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    // Quiet threshold eventually completes pending.
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

  it('does not auto-complete quiet codex pending without output when event hook mode is active', async () => {
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
      'same screen',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();

    poller.stop();
  });

  it('does not quiet-complete codex with output candidates when event hook mode is active', async () => {
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
      'baseline',
      'baseline\nassistant output candidate',
      'baseline\nassistant output candidate',
      'baseline\nassistant output candidate',
      'baseline\nassistant output candidate',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const eventHookClient = {
      enabled: true,
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      eventHookClient,
      intervalMs: 300,
    });

    poller.start();
    await Promise.resolve();
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
    }

    expect(pendingTracker.markCompleted).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalled();

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

  it('auto-recovers stale pending once at stage-2 by marking retry', async () => {
    process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS = '1000';
    process.env.AGENT_DISCORD_CAPTURE_STALE_AUTO_RECOVER = '1';

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
      'same screen',
      'same screen',
      'same screen',
      'same screen',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markRetry: vi.fn().mockResolvedValue(undefined),
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
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(pendingTracker.markRetry).toHaveBeenCalledTimes(1);
    expect(pendingTracker.markRetry).toHaveBeenCalledWith('demo', 'codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'thread-ch',
      expect.stringContaining('Auto-recover triggered'),
    );

    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    expect(pendingTracker.markRetry).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('reconciles missing orchestrator workers after repeated missing-window polls', async () => {
    process.env.AGENT_DISCORD_ORCHESTRATOR_DEAD_WORKER_MISSING_POLLS = '2';

    let projectState: any = {
      projectName: 'demo',
      projectPath: '/tmp/demo',
      tmuxSession: 'agent-demo',
      orchestrator: {
        enabled: true,
        supervisorInstanceId: 'codex',
        workerInstanceIds: ['codex-2'],
        workerFinalVisibility: 'hidden',
      },
      instances: {
        codex: {
          instanceId: 'codex',
          agentType: 'codex',
          tmuxWindow: 'demo-codex',
          channelId: 'ch-super',
          eventHook: false,
        },
        'codex-2': {
          instanceId: 'codex-2',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-2',
          eventHook: false,
        },
      },
    };
    const stateManager = {
      listProjects: vi.fn().mockImplementation(() => [projectState]),
      getProject: vi.fn().mockImplementation((name: string) => (name === projectState.projectName ? projectState : undefined)),
      setProject: vi.fn().mockImplementation((next: any) => {
        projectState = next;
      }),
    } as any;
    const messaging = createMessaging('discord');
    const tmux = {
      capturePaneFromWindow: vi.fn().mockReturnValue('supervisor idle'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      windowExists: vi.fn().mockImplementation((_session: string, windowName: string) => windowName !== 'demo-codex-2'),
    } as any;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue(undefined),
      getPendingDepth: vi.fn().mockReturnValue(0),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
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

    expect(stateManager.setProject).toHaveBeenCalled();
    expect(projectState.instances['codex-2']).toBeUndefined();
    expect(projectState.orchestrator.workerInstanceIds || []).toEqual([]);
    expect(pendingTracker.clearPendingForInstance).toHaveBeenCalledWith('demo', 'codex', 'codex-2');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-super',
      expect.stringContaining('Removed stale worker `codex-2`'),
    );

    poller.stop();
  });

  it('uses default dead-worker threshold when env is unset', async () => {
    let projectState: any = {
      projectName: 'demo',
      projectPath: '/tmp/demo',
      tmuxSession: 'agent-demo',
      orchestrator: {
        enabled: true,
        supervisorInstanceId: 'codex',
        workerInstanceIds: ['codex-2'],
        workerFinalVisibility: 'hidden',
      },
      instances: {
        codex: {
          instanceId: 'codex',
          agentType: 'codex',
          tmuxWindow: 'demo-codex',
          channelId: 'ch-super',
          eventHook: false,
        },
        'codex-2': {
          instanceId: 'codex-2',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-2',
          eventHook: false,
        },
      },
    };
    const stateManager = {
      listProjects: vi.fn().mockImplementation(() => [projectState]),
      getProject: vi.fn().mockImplementation((name: string) => (name === projectState.projectName ? projectState : undefined)),
      setProject: vi.fn().mockImplementation((next: any) => {
        projectState = next;
      }),
    } as any;
    const messaging = createMessaging('discord');
    const tmux = {
      capturePaneFromWindow: vi.fn().mockReturnValue('supervisor idle'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      windowExists: vi.fn().mockImplementation((_session: string, windowName: string) => windowName !== 'demo-codex-2'),
    } as any;
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue(undefined),
      getPendingDepth: vi.fn().mockReturnValue(0),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 250,
    });

    poller.start();
    await Promise.resolve();
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
    }

    expect(stateManager.setProject).toHaveBeenCalled();
    expect(projectState.instances['codex-2']).toBeUndefined();
    expect(projectState.orchestrator.workerInstanceIds || []).toEqual([]);
    expect(pendingTracker.clearPendingForInstance).toHaveBeenCalledWith('demo', 'codex', 'codex-2');

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

  it('keeps codex on capture-driven path even when local hook client is enabled', async () => {

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
      'boot line\nwould be direct capture',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(false);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(800);

    expect(staleChecker).not.toHaveBeenCalled();
    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalled();

    poller.stop();
  });

  it('keeps codex capture flow active even when lifecycle checker reports stale', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '0';

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
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-stale-fallback-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).not.toHaveBeenCalled();
    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalled();

    poller.stop();
  });

  it('does not emit direct codex fallback capture output even when fallback output forwarding is enabled', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '0';
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT = '1';

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
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingMessageId: vi.fn().mockReturnValue('msg-stale-fallback-output-1'),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).not.toHaveBeenCalled();
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-stale-fallback-output-1',
      channelId: 'thread-ch',
      text: 'fallback delta',
    });
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('polls event-hook instances when lifecycle stale fallback is active', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '0';

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
    const tmux = createTmux([
      'boot line',
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).toHaveBeenCalledWith('demo', 'claude', 'claude');
    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('emits legacy direct fallback output when event-hook capture output is enabled', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '0';
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT = '1';

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
    const tmux = createTmux([
      'boot line',
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).toHaveBeenCalledWith('demo', 'claude', 'claude');
    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'fallback delta');

    poller.stop();
  });

  it('waits stale-grace window before enabling event-hook capture fallback', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '1200';

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
    const tmux = createTmux([
      'boot line',
      'boot line\nfallback delta',
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).toHaveBeenCalled();
    expect(tmux.capturePaneFromWindow).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('keeps codex capture-driven flow even when eventHook flag and stale checker are set', async () => {
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
            eventHook: true,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const tmux = createTmux([
      'boot line',
      'boot line\nfallback delta',
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('thread-ch'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);

    expect(staleChecker).not.toHaveBeenCalled();
    expect(tmux.capturePaneFromWindow).toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith('thread-ch', 'fallback delta');

    poller.stop();
  });

  it('does not enable stale fallback capture when event-hook instance has no pending activity', async () => {
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
    const tmux = createTmux(['boot line\nwould have been captured']);
    const pendingTracker = createPendingTracker();
    const staleChecker = vi.fn().mockReturnValue(true);

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 400,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(800);

    expect(staleChecker).toHaveBeenCalledWith('demo', 'claude', 'claude');
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

  it('suppresses codex transient draft frames that include progress + diff artifacts', async () => {
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
        '635    while (true) {',
        '636      printInteractiveMenu();',
        "566 -    const choiceRaw = await prompt(chalk.white('\\nSelect action [1-9]: '));",
        "637 +    const choiceRaw = await prompt(chalk.white('\\nSelect action [1-9] (q to quit): '));",
        "639 +    if (normalized === 'q' || normalized === 'quit' || normalized === 'exit') {",
        '• Crafting comprehensive interactive launcher response',
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

    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    poller.stop();
  });

  it('strips codex transient progress lines but keeps assistant content', async () => {
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
        '• Crafting comprehensive interactive launcher response',
        'assistant: final answer ready',
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: final answer ready');

    poller.stop();
  });

  it('filters codex working progress row and prompt echo frame as transient noise', async () => {
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
    const echoedPromptTail = 'Use /skills to list available skills';
    const tmux = createTmux([
      'boot line',
      ['boot line', '• Working (3s • esc to interrupt)', `› ${echoedPromptTail}`].join('\n'),
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

    poller.stop();
  });

  it('filters codex adjusting-query progress row and prompt echo frame as transient noise', async () => {
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
        '• Adjusting query approach (14m 33s • esc to interrupt)',
        '› Write tests for @filename',
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

    expect(messaging.sendToChannel).not.toHaveBeenCalled();

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

  it('does not anchor on codex tail prompt/footer when answer is rendered above them', async () => {
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
    const prompt = 'how should I run this, and what is the exact execution order?';
    const footer = 'gpt-5.3-codex xhigh · 31% left · ~/yonsei/mud/ar_xapp_v3';
    const tmux = createTmux([
      ['old view line', `› ${prompt}`, footer].join('\n'),
      ['assistant: here is the exact execution order.', `› ${prompt}`, footer].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(1),
      getPendingPromptTail: vi.fn().mockReturnValue(prompt),
      getPendingPromptTails: vi.fn().mockReturnValue([prompt]),
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

    const payloads = messaging.sendToChannel.mock.calls.map((args: any[]) => String(args[1] ?? ''));
    expect(payloads.join('\n')).toContain('assistant: here is the exact execution order.');

    poller.stop();
  });

  it('keeps assistant lines in redraw fallback tail when no anchor matches', async () => {
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
            eventHook: false,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const previous = Array.from({ length: 120 }, (_, i) => `old-line-${i}`).join('\n');
    const currentLines = [
      ...Array.from({ length: 30 }, (_, i) => `new-head-${i}`),
      'assistant: ubuntu redraw fallback should include this line',
      ...Array.from({ length: 45 }, (_, i) => `new-tail-${i}`),
    ];
    const current = currentLines.join('\n');
    const tmux = createTmux([previous, current]);
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

    const joinedPayload = messaging.sendToChannel.mock.calls.map((args: any[]) => String(args[1] ?? '')).join('\n');
    const longOutputPayload = String(messaging.sendLongOutput.mock.calls[0]?.[1] || '');
    expect(joinedPayload + '\n' + longOutputPayload).toContain(
      'assistant: ubuntu redraw fallback should include this line',
    );

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

  it('does not send codex tab-to-queue status updates', async () => {
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
      ['boot line', 'tab to queue message                                        49% context left'].join('\n'),
      ['boot line', 'tab to queue message                                        42% context left'].join('\n'),
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

  it('filters pending codex input echo lines with codex prompt marker prefix', async () => {
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
    const echoedPromptTail = 'Write tests for @filename';
    const tmux = createTmux([
      'boot line',
      ['boot line', `› ${echoedPromptTail}`, 'assistant: done'].join('\n'),
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: done');
    const joinedPayload = messaging.sendToChannel.mock.calls.map((args: any[]) => String(args[1] ?? '')).join('\n');
    expect(joinedPayload).not.toContain(`› ${echoedPromptTail}`);

    poller.stop();
  });

  it('filters short exact prompt echo lines while keeping assistant output', async () => {
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
    const echoedPromptTail = 'hi';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedPromptTail, 'assistant: hello there'].join('\n'),
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: hello there');
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('ch-1', echoedPromptTail);

    poller.stop();
  });

  it('filters wrapped prompt echo fragments at the top of delta', async () => {
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
    const echoedPromptTail = 'this is a wrapped prompt echo that appears in small fragments at the top';
    const tmux = createTmux([
      'boot line',
      [
        'boot line',
        'this is a wrapped prompt',
        'echo that appears in',
        'small fragments at the top',
        'assistant: response starts here',
      ].join('\n'),
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

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'assistant: response starts here');
    const joinedPayload = messaging.sendToChannel.mock.calls.map((args: any[]) => String(args[1] ?? '')).join('\n');
    expect(joinedPayload).not.toContain('this is a wrapped prompt');

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

  it('does not send raw prompt-echo fallback delta for codex capture path by default', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '0';
    process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS = '1';

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
            eventHook: true,
          },
        },
      },
    ]);
    const messaging = createMessaging('discord');
    const echoedLine1 = 'this is an intentionally long prompt suffix for pending echo filtering hook one 1234567890';
    const echoedLine2 = 'this is an intentionally long prompt suffix for pending echo filtering hook two 1234567890';
    const tmux = createTmux([
      'boot line',
      ['boot line', echoedLine1].join('\n'),
      ['boot line', echoedLine2].join('\n'),
    ]);
    const pendingTracker = {
      getPendingChannel: vi.fn().mockReturnValue('ch-1'),
      getPendingDepth: vi.fn().mockReturnValue(2),
      getPendingPromptTails: vi.fn().mockReturnValue([echoedLine1, echoedLine2]),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    } as any;
    const staleChecker = vi.fn().mockReturnValue(true);
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const poller = new BridgeCapturePoller({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      intervalMs: 300,
      eventHookClient,
      eventLifecycleStaleChecker: staleChecker,
    });

    poller.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(staleChecker).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith('ch-1', echoedLine2);
    expect(eventHookClient.emitCodexProgress).toHaveBeenCalled();

    poller.stop();
  });
});
