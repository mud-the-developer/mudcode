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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
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
});
