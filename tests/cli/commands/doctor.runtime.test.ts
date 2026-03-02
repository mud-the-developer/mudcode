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
  return {
    config,
    getConfigPath,
    getConfigValue,
    saveConfig,
    validateConfig,
    fetchMock,
  };
});

vi.mock('../../../src/config/index.js', () => ({
  config: mocks.config,
  getConfigPath: mocks.getConfigPath,
  getConfigValue: mocks.getConfigValue,
  saveConfig: mocks.saveConfig,
  validateConfig: mocks.validateConfig,
}));

describe('runDoctor runtime contract checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetchMock as any);
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_FALLBACK_EVENT_HOOK;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
    mocks.config.promptRefiner = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK;
    delete process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_FALLBACK_EVENT_HOOK;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS;
  });

  it('adds event-contract-progress-channel warning when event-only is enabled and codex runtime mode is channel', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
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

  it('does not add event-contract-progress-channel warning when event-only is disabled', async () => {
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

    expect(result.issues.some((issue) => issue.code === 'event-contract-progress-channel')).toBe(false);
    expect(result.summary.runtimeCodexProgressModeChannel).toBe(1);
  });

  it('adds strict parity warning when event-only capture fallback remains enabled', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK = '1';
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        instances: [],
      }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-only-capture-fallback-enabled')).toBe(true);
  });

  it('adds prompt-echo fallback warning when event-only runs with raw delta fallback on event-hook capture', async () => {
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
    process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_FALLBACK_EVENT_HOOK = '1';
    process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS = '45000';
    process.env.AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK = '1';
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ instances: [] }),
    });

    const { runDoctor } = await import('../../../src/cli/commands/doctor.js');
    const result = await runDoctor();

    expect(result.issues.some((issue) => issue.code === 'event-only-prompt-echo-fallback-event-hook-enabled')).toBe(
      true,
    );
    expect(result.issues.some((issue) => issue.code === 'event-only-capture-fallback-grace-high')).toBe(true);
    expect(result.summary.eventOnlyPromptEchoFallbackEventHookEnabled).toBe(true);
    expect(result.summary.eventHookCaptureFallbackStaleGraceMs).toBe(45000);
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
