import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const validateConfig = vi.fn();
  const getConfigPath = vi.fn().mockReturnValue('/tmp/.mudcode/config.json');
  const config = {
    discord: { token: 'token' },
    tmux: { sessionPrefix: '', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
  };

  const stateManager = {
    listProjects: vi.fn().mockReturnValue([]),
  };

  const getDaemonStatus = vi.fn().mockResolvedValue({
    running: true,
    port: 18470,
    logFile: '/tmp/daemon.log',
    pidFile: '/tmp/daemon.pid',
  });

  const tmux = {
    sessionExistsFull: vi.fn().mockReturnValue(true),
    windowExists: vi.fn().mockReturnValue(true),
    capturePaneFromWindow: vi.fn().mockReturnValue(''),
  };
  const createTmuxManager = vi.fn().mockImplementation(function MockTmuxManager() {
    return tmux;
  });
  const fetchMock = vi.fn();

  return {
    validateConfig,
    getConfigPath,
    config,
    stateManager,
    getDaemonStatus,
    tmux,
    createTmuxManager,
    fetchMock,
  };
});

vi.mock('../../../src/config/index.js', () => ({
  validateConfig: mocks.validateConfig,
  getConfigPath: mocks.getConfigPath,
  config: mocks.config,
}));

vi.mock('../../../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../../../src/app/daemon-service.js', () => ({
  getDaemonStatus: mocks.getDaemonStatus,
}));

vi.mock('../../../src/tmux/manager.js', () => ({
  TmuxManager: vi.fn(),
}));

vi.mock('../../../src/tmux/factory.js', () => ({
  createTmuxManager: mocks.createTmuxManager,
}));

describe('healthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateConfig.mockImplementation(() => {});
    process.exitCode = 0;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS;
    delete process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_COUNT;
    delete process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_WINDOW_MS;
    mocks.stateManager.listProjects.mockReturnValue([]);
    mocks.getDaemonStatus.mockResolvedValue({
      running: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
      pidFile: '/tmp/daemon.pid',
    });
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: new Date().toISOString(), instances: [] }),
    });
    mocks.tmux.capturePaneFromWindow.mockReturnValue('');
    vi.stubGlobal('fetch', mocks.fetchMock as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS;
    delete process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_COUNT;
    delete process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_WINDOW_MS;
  });

  it('reports healthy summary in json mode when checks pass', async () => {
    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBe(0);
    expect(payload.summary.warn).toBeGreaterThanOrEqual(1); // no projects warning
    expect(payload.summary.ok).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
  });

  it('sets non-zero exit code when config validation fails', async () => {
    mocks.validateConfig.mockImplementation(() => {
      throw new Error('invalid config');
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBe(1);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('downgrades empty orchestrator worker-only project to informational check', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo-empty',
        projectPath: '/tmp/demo-empty',
        tmuxSession: 'bridge',
        agents: {},
        discordChannels: {},
        orchestrator: {
          enabled: true,
          workerFinalVisibility: 'hidden',
        },
        instances: {},
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'project:demo-empty' &&
          c.level === 'ok' &&
          String(c.detail || '').includes('orchestrator workers cleaned'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('includes runtime pending status per instance in json mode', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 1,
            oldestStage: 'processing',
            oldestAgeMs: 2000,
            eventProgressMode: 'thread',
            eventProgressModeTurnId: 'msg-runtime-1',
          },
        ],
      }),
    });
    mocks.tmux.capturePaneFromWindow.mockReturnValue('? for shortcuts                                Esc to interrupt');

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.instances[0].projectName).toBe('demo');
    expect(payload.instances[0].runtime.pendingDepth).toBe(1);
    expect(payload.instances[0].runtime.oldestStage).toBe('processing');
    expect(payload.instances[0].runtime.eventProgressMode).toBe('thread');
    expect(payload.instances[0].runtime.eventProgressModeTurnId).toBe('msg-runtime-1');
    expect(payload.instances[0].paneWorkingHint).toBe(true);
    expect(mocks.fetchMock).toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it('includes runtime perf metrics snapshot in json mode', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [],
        perfMetrics: {
          generatedAt: new Date().toISOString(),
          uptimeMs: 10_000,
          timers: {
            router_message_latency_ms: { count: 4, avgMs: 18, minMs: 8, maxMs: 40, lastMs: 15, p50Ms: 14, p95Ms: 38 },
            capture_poll_iteration_ms: { count: 12, avgMs: 9, minMs: 4, maxMs: 17, lastMs: 7, p50Ms: 8, p95Ms: 16 },
            state_save_ms: { count: 3, avgMs: 3, minMs: 2, maxMs: 4, lastMs: 3, p50Ms: 3, p95Ms: 4 },
          },
          counters: {
            tmux_exec_count: { total: 24, byOp: { send_keys: 12, capture_pane: 8 } },
          },
          stateSaveFrequency: { inLastMinute: 1, inLast5Minutes: 2, perMinuteLast5Minutes: 0.4 },
        },
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.perfMetrics).toBeDefined();
    expect(payload.perfMetrics.timers.router_message_latency_ms.count).toBe(4);
    expect(payload.perfMetrics.counters.tmux_exec_count.total).toBe(24);

    logSpy.mockRestore();
  });

  it('queries runtime status with an abortable timeout signal', async () => {
    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const runtimeFetchCall = mocks.fetchMock.mock.calls.find(
      (call) => String(call?.[0] || '').includes('/runtime-status'),
    );
    const init = runtimeFetchCall?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeDefined();

    logSpy.mockRestore();
  });

  it('prints compact perf metrics line in text mode', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [],
        perfMetrics: {
          generatedAt: new Date().toISOString(),
          uptimeMs: 8_000,
          timers: {
            router_message_latency_ms: { count: 2, avgMs: 10, minMs: 7, maxMs: 13, lastMs: 13, p50Ms: 10, p95Ms: 13 },
            capture_poll_iteration_ms: { count: 6, avgMs: 6, minMs: 4, maxMs: 9, lastMs: 6, p50Ms: 6, p95Ms: 9 },
            state_save_ms: { count: 2, avgMs: 2, minMs: 2, maxMs: 3, lastMs: 2, p50Ms: 2, p95Ms: 3 },
          },
          counters: {
            tmux_exec_count: { total: 10, byOp: { send_keys: 5, capture_pane: 2 } },
          },
          stateSaveFrequency: { inLastMinute: 1, inLast5Minutes: 1, perMinuteLast5Minutes: 0.2 },
        },
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand();

    const lines = logSpy.mock.calls.map((call) => String(call[0] || ''));
    expect(lines.some((line) => line.includes('perf: router p95='))).toBe(true);

    logSpy.mockRestore();
  });

  it('runs capture probe when capture-test is enabled', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { claude: true },
        discordChannels: { claude: 'ch-1' },
        instances: {
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'demo-claude',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'claude',
            agentType: 'claude',
            pendingDepth: 1,
            oldestStage: 'processing',
            oldestAgeMs: 2000,
          },
        ],
      }),
    });
    const samples = ['line1', 'line1\nline2', 'line1\nline2\nline3'];
    mocks.tmux.capturePaneFromWindow.mockImplementation(() => samples.shift() || 'line1\nline2\nline3');

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true, captureTest: true, captureTestPolls: 3, captureTestIntervalMs: 1 });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.instances[0].captureProbe.enabled).toBe(true);
    expect(payload.instances[0].captureProbe.captures).toBe(3);
    expect(payload.instances[0].captureProbe.changes).toBeGreaterThanOrEqual(1);
    expect(payload.instances[0].captureProbe.status).toBe('ok');
    expect(
      payload.checks.some((c: { name?: string }) => c.name === 'capture-probe'),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('reports ignored hook events from runtime status', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 0,
            ignoredEventCount: 3,
            ignoredEventTypes: { 'session.idle': 3 },
            ignoredLastAt: new Date().toISOString(),
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.instances[0].runtime.ignoredEventCount).toBe(3);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'hook:demo/codex' && c.level === 'ok' && String(c.detail || '').includes('ignored 3'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('warns on ignored hook events when recent count exceeds threshold', async () => {
    process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_COUNT = '2';
    process.env.AGENT_DISCORD_IGNORED_EVENT_WARN_WINDOW_MS = '600000';
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 0,
            ignoredEventCount: 3,
            ignoredEventTypes: { 'session.idle': 3 },
            ignoredLastAt: new Date().toISOString(),
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'hook:demo/codex' &&
          c.level === 'warn' &&
          String(c.detail || '').includes('ignored 3'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('reports lifecycle strict rejects from runtime status', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 0,
            lifecycleRejectedEventCount: 2,
            lifecycleRejectedEventTypes: { 'session.final': 2 },
            lifecycleRejectedLastAt: new Date().toISOString(),
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.instances[0].runtime.lifecycleRejectedEventCount).toBe(2);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'contract:demo/codex' && c.level === 'warn' && String(c.detail || '').includes('rejected 2'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('reports progress suppression counters from runtime status', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 1,
            oldestStage: 'processing',
            oldestAgeMs: 1200,
            eventProgressSuppressedCount: 2,
            eventProgressSuppressedChars: 14,
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.instances[0].runtime.eventProgressSuppressedCount).toBe(2);
    expect(payload.instances[0].runtime.eventProgressSuppressedChars).toBe(14);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'hook:demo/codex' &&
          c.level === 'warn' &&
          String(c.detail || '').includes('suppressed 2 progress update'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('warns when codex runtime mode is channel', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE = 'thread';
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 1,
            oldestStage: 'processing',
            oldestAgeMs: 2000,
            eventProgressMode: 'channel',
            eventProgressModeAgeMs: 1500,
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    const contractWarns = payload.checks.filter((c: { name?: string; level?: string; detail?: string }) =>
      c.name === 'contract:demo/codex' &&
      c.level === 'warn' &&
      (String(c.detail || '').includes('progressMode=channel') || String(c.detail || '').includes('differs from expected')),
    );
    expect(contractWarns.length).toBeGreaterThanOrEqual(1);

    logSpy.mockRestore();
  });

  it('warns when codex runtime fallback stale grace is high even when legacy event-only env is disabled', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '0';
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '45000';

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    const contractWarnings = payload.checks.filter(
      (c: { name?: string; level?: string; detail?: string }) =>
        c.name === 'contract:codex-runtime' && c.level === 'warn',
    );
    expect(contractWarnings.length).toBeGreaterThanOrEqual(1);
    expect(
      contractWarnings.some((c: { detail?: string }) =>
        String(c.detail || '').includes('stale grace is high'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('warns when progress mode runtime signal is stale while pending', async () => {
    process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS = '5000';
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 2,
            oldestStage: 'processing',
            oldestAgeMs: 3000,
            eventProgressMode: 'thread',
            eventProgressModeAgeMs: 12000,
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'contract:demo/codex' &&
          c.level === 'warn' &&
          String(c.detail || '').includes('signal stale'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it('scopes checks to one project when --project is provided', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
      {
        projectName: 'stale',
        projectPath: '/tmp/stale',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: {},
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'stale-codex',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true, project: 'demo' });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBe(0);
    expect(payload.instances).toHaveLength(1);
    expect(payload.instances[0].projectName).toBe('demo');
    expect(
      payload.checks.some((c: { name?: string }) => String(c.name || '').includes('stale')),
    ).toBe(false);
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
  });

  it('fails when requested health project does not exist', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-1' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-1',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true, project: 'missing' });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBeGreaterThanOrEqual(1);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'projects' &&
          c.level === 'fail' &&
          String(c.detail || '').includes("project 'missing' not found"),
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });

  it('does not fail when orchestrator worker instance has no channel mapping', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        discordChannels: { codex: 'ch-supervisor' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-supervisor',
          },
          'codex-2': {
            instanceId: 'codex-2',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-2',
          },
        },
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            pendingDepth: 0,
          },
          {
            projectName: 'demo',
            instanceId: 'codex-2',
            agentType: 'codex',
            pendingDepth: 0,
          },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBe(0);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'instance:demo/codex-2' &&
          c.level === 'ok' &&
          String(c.detail || '').includes('optional for orchestrator worker'),
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(0);

    logSpy.mockRestore();
  });

  it('fails when one channel is mapped to multiple instances', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true, claude: true },
        discordChannels: { codex: 'ch-dup', claude: 'ch-dup' },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
            channelId: 'ch-dup',
          },
          claude: {
            instanceId: 'claude',
            agentType: 'claude',
            tmuxWindow: 'demo-claude',
            channelId: 'ch-dup',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date().toISOString(),
        instances: [
          { projectName: 'demo', instanceId: 'codex', agentType: 'codex', pendingDepth: 0 },
          { projectName: 'demo', instanceId: 'claude', agentType: 'claude', pendingDepth: 0 },
        ],
      }),
    });

    const { healthCommand } = await import('../../../src/cli/commands/health.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await healthCommand({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0] || '{}'));
    expect(payload.summary.fail).toBeGreaterThanOrEqual(1);
    expect(
      payload.checks.some(
        (c: { name?: string; level?: string; detail?: string }) =>
          c.name === 'mapping:duplicate-channel' &&
          c.level === 'fail' &&
          String(c.detail || '').includes('ch-dup'),
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(1);

    logSpy.mockRestore();
  });
});
