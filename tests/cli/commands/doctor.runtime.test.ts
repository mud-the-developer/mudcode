import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const config = {
    hookServerPort: 18470,
    capture: { longOutputThreadThreshold: 2000 },
  };
  const getConfigPath = vi.fn().mockReturnValue('/tmp/.mudcode/config.json');
  const getConfigValue = vi.fn().mockReturnValue(undefined);
  const saveConfig = vi.fn();
  const validateConfig = vi.fn();
  const fetchMock = vi.fn();
  const stateManager = {
    listProjects: vi.fn().mockReturnValue([]),
  };
  return {
    config,
    getConfigPath,
    getConfigValue,
    saveConfig,
    validateConfig,
    fetchMock,
    stateManager,
  };
});

vi.mock('../../../src/config/index.js', () => ({
  config: mocks.config,
  getConfigPath: mocks.getConfigPath,
  getConfigValue: mocks.getConfigValue,
  saveConfig: mocks.saveConfig,
  validateConfig: mocks.validateConfig,
}));

vi.mock('../../../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

describe('runDoctor runtime contract checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetchMock as any);
    mocks.stateManager.listProjects.mockReturnValue([]);
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    mocks.config.promptRefiner = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
  });

  it('adds event-contract-progress-channel warning when codex runtime mode is channel', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            eventProgressMode: 'channel',
            lifecycleRejectedEventCount: 0,
          },
        ],
      }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-contract-progress-channel')).toBe(true);
    expect(result.summary.runtimeCodexProgressModeChannel).toBe(1);
    expect(result.summary.runtimeProgressModeChannel).toBe(1);
  });

  it('still adds event-contract-progress-channel warning when legacy event-only env is disabled', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '0';
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            eventProgressMode: 'channel',
            lifecycleRejectedEventCount: 0,
          },
        ],
      }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-contract-progress-channel')).toBe(true);
    expect(result.summary.runtimeCodexProgressModeChannel).toBe(1);
  });

  it('adds event-hook fallback warning when stale grace is high', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '45000';
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-only-capture-fallback-grace-high')).toBe(true);
    expect(result.summary.eventHookCaptureFallbackStaleGraceMs).toBe(45000);
  });

  it('adds strict lifecycle warning when strict mode is off', async () => {
    process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE = 'off';
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-contract-strict-off')).toBe(true);
  });

  it('adds orchestrator worker policy warnings when runtime visibility and progress mode drift', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        instances: [
          {
            projectName: 'demo',
            instanceId: 'codex',
            agentType: 'codex',
            orchestratorRole: 'supervisor',
            orchestratorSupervisorFinalFormatEnforce: true,
            eventProgressMode: 'off',
            lifecycleRejectedEventCount: 0,
          },
          {
            projectName: 'demo',
            instanceId: 'codex-2',
            agentType: 'codex',
            orchestratorRole: 'worker',
            orchestratorWorkerVisibility: 'hidden',
            eventProgressMode: 'thread',
            lifecycleRejectedEventCount: 0,
          },
          {
            projectName: 'demo',
            instanceId: 'codex-3',
            agentType: 'codex',
            orchestratorRole: 'worker',
            orchestratorWorkerVisibility: 'thread',
            eventProgressMode: 'channel',
            lifecycleRejectedEventCount: 0,
          },
        ],
      }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'orchestrator-worker-hidden-progress-leak')).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'orchestrator-worker-thread-channel-mismatch')).toBe(true);
    expect(result.summary.runtimeOrchestratorSupervisorCount).toBe(1);
    expect(result.summary.runtimeOrchestratorWorkerCount).toBe(2);
    expect(result.summary.runtimeOrchestratorWorkerHiddenModeLeakCount).toBe(1);
    expect(result.summary.runtimeOrchestratorWorkerThreadChannelMismatchCount).toBe(1);
    expect(result.summary.runtimeOrchestratorSupervisorFinalFormatEnforceCount).toBe(1);
  });

  it('fails when non-worker instances are missing channel mappings in state', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
        instances: {
          codex: {
            instanceId: 'codex',
            agentType: 'codex',
            tmuxWindow: 'demo-codex',
          },
        },
        createdAt: new Date(),
        lastActive: new Date(),
      },
    ]);
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'mapping-required-channel-missing')).toBe(true);
    expect(result.summary.stateMappingRequiredMissingCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('fails when one channel id is assigned to multiple instances in state', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true, claude: true },
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
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'mapping-duplicate-channel-id')).toBe(true);
    expect(result.summary.stateMappingDuplicateChannelCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('does not fail for channel-less orchestrator workers', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
        projectPath: '/tmp/demo',
        tmuxSession: 'bridge',
        agents: { codex: true },
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
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'mapping-required-channel-missing')).toBe(false);
    expect(result.summary.stateMappingOptionalWorkerMissingCount).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('warns when prompt-refiner enforce mode has no policy path', async () => {
    mocks.config.promptRefiner = {
      mode: 'enforce',
    };
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'prompt-refiner-enforce-no-policy-path')).toBe(true);
    expect(result.summary.promptRefinerMode).toBe('enforce');
    expect(result.summary.promptRefinerPolicyPath).toBeUndefined();
  });

  it('auto-fixes enforce mode without policy path by downgrading to shadow', async () => {
    mocks.config.promptRefiner = {
      mode: 'enforce',
    };
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor({ fix: true });

    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ promptRefinerMode: 'shadow' }));
    expect(result.fixes.some((fix) => fix.code === 'prompt-refiner-safe-downgrade')).toBe(true);
  });
});
