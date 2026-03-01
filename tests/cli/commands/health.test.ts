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
    process.exitCode = 0;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS;
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
    delete process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS;
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
          c.name === 'hook:demo/codex' && c.level === 'warn' && String(c.detail || '').includes('ignored 3'),
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

  it('warns when codex event-only runtime mode is channel', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
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
});
