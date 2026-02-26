import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const bridgeInstances: any[] = [];
  const AgentBridge = vi.fn().mockImplementation(function MockAgentBridge() {
    const instance = {
      start: vi.fn().mockResolvedValue(undefined),
    };
    bridgeInstances.push(instance);
    return instance;
  });

  const stateManager = {
    listProjects: vi.fn().mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        createdAt: new Date(),
        lastActive: new Date(),
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
      },
    ]),
    getGuildId: vi.fn().mockReturnValue('guild-1'),
  };

  const config = {
    discord: { token: 'token' },
    tmux: { sessionPrefix: 'agent-', sharedSessionName: 'bridge' },
    hookServerPort: 18470,
  };

  const ensureDaemonRunning = vi.fn().mockResolvedValue({
    alreadyRunning: false,
    ready: true,
    port: 18470,
    logFile: '/tmp/daemon.log',
  });

  const listProjectInstances = vi.fn().mockImplementation((project: any) =>
    Object.values(project.instances || {}),
  );

  const resolveProjectWindowName = vi.fn().mockReturnValue('demo-claude');
  const attachToTmux = vi.fn();
  const ensureTmuxInstalled = vi.fn();
  const applyTmuxCliOverrides = vi.fn().mockImplementation((cfg: any) => cfg);

  const agentRegistry = {
    get: vi.fn().mockReturnValue({
      config: {
        displayName: 'Claude Code',
      },
    }),
  };

  return {
    AgentBridge,
    bridgeInstances,
    stateManager,
    config,
    ensureDaemonRunning,
    listProjectInstances,
    resolveProjectWindowName,
    attachToTmux,
    ensureTmuxInstalled,
    applyTmuxCliOverrides,
    agentRegistry,
  };
});

vi.mock('../src/index.js', () => ({
  AgentBridge: mocks.AgentBridge,
}));

vi.mock('../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../src/config/index.js', () => ({
  config: mocks.config,
  getConfigPath: vi.fn().mockReturnValue('/tmp/mudcode/config.json'),
  validateConfig: vi.fn(),
}));

vi.mock('../src/agents/index.js', () => ({
  agentRegistry: mocks.agentRegistry,
}));

vi.mock('../src/state/instances.js', () => ({
  listProjectInstances: mocks.listProjectInstances,
}));

vi.mock('../src/app/daemon-service.js', () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
}));

vi.mock('../src/cli/common/tmux.js', () => ({
  applyTmuxCliOverrides: mocks.applyTmuxCliOverrides,
  attachToTmux: mocks.attachToTmux,
  ensureTmuxInstalled: mocks.ensureTmuxInstalled,
  resolveProjectWindowName: mocks.resolveProjectWindowName,
}));

describe('startCommand runtime routing', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bridgeInstances.length = 0;
    process.env = { ...originalEnv };
    delete process.env.MUDCODE_DAEMON_RUNTIME;

    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'agent-demo',
        createdAt: new Date(),
        lastActive: new Date(),
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
      },
    ]);

    mocks.listProjectInstances.mockImplementation((project: any) =>
      Object.values(project.instances || {}),
    );

    mocks.ensureDaemonRunning.mockResolvedValue({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
    });

    mocks.resolveProjectWindowName.mockReturnValue('demo-claude');
  });

  it('uses foreground AgentBridge runtime by default', async () => {
    const { startCommand } = await import('../src/cli/commands/start.js');

    await startCommand({});

    expect(mocks.AgentBridge).toHaveBeenCalledOnce();
    expect(mocks.bridgeInstances[0].start).toHaveBeenCalledOnce();
    expect(mocks.ensureDaemonRunning).not.toHaveBeenCalled();
  });

  it('uses daemon-service when rust runtime is selected', async () => {
    process.env.MUDCODE_DAEMON_RUNTIME = 'rust';
    const { startCommand } = await import('../src/cli/commands/start.js');

    await startCommand({});

    expect(mocks.ensureDaemonRunning).toHaveBeenCalledOnce();
    expect(mocks.AgentBridge).not.toHaveBeenCalled();
  });

  it('attaches to tmux after rust daemon startup when --attach is used', async () => {
    process.env.MUDCODE_DAEMON_RUNTIME = 'rust';
    const { startCommand } = await import('../src/cli/commands/start.js');

    await startCommand({ project: 'demo', attach: true });

    expect(mocks.ensureDaemonRunning).toHaveBeenCalledOnce();
    expect(mocks.attachToTmux).toHaveBeenCalledWith('agent-demo', 'demo-claude');
  });
});
