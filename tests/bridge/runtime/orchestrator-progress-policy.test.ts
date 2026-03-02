import { describe, expect, it } from 'vitest';
import { normalizeProjectState } from '../../../src/state/instances.js';
import {
  resolveOrchestratorRole,
  resolveOrchestratorWorkerVisibility,
  resolveProgressPolicyDirective,
} from '../../../src/bridge/runtime/orchestrator-progress-policy.js';

function createProjectWithOrchestrator(orchestrator: Record<string, unknown>) {
  const now = new Date();
  return normalizeProjectState({
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
      'codex-2': {
        instanceId: 'codex-2',
        agentType: 'codex',
        tmuxWindow: 'demo-codex-2',
        channelId: 'ch-2',
        eventHook: false,
      },
    },
    orchestrator,
  });
}

describe('orchestrator-progress-policy', () => {
  it('resolves progress policy directive with openclaw-style override precedence', () => {
    const project = createProjectWithOrchestrator({
      enabled: true,
      supervisorInstanceId: 'codex',
      workerInstanceIds: ['codex-2'],
      workerFinalVisibility: 'hidden',
      progressPolicy: {
        default: {
          mode: 'off',
          blockWindowMs: 600,
        },
        byAgentType: {
          codex: {
            mode: 'thread',
            blockStreamingEnabled: true,
          },
        },
        byInstanceId: {
          'codex-2': {
            blockMaxChars: 2200,
          },
        },
        byChannelId: {
          'ch-2': {
            mode: 'channel',
          },
        },
      },
    });

    const resolved = resolveProgressPolicyDirective({
      project,
      agentType: 'codex',
      instanceId: 'codex-2',
      channelId: 'ch-2',
    });

    expect(resolved).toMatchObject({
      mode: 'channel',
      blockWindowMs: 600,
      blockStreamingEnabled: true,
      blockMaxChars: 2200,
    });
  });

  it('resolves worker visibility for registered workers and keeps supervisor visible', () => {
    const project = createProjectWithOrchestrator({
      enabled: true,
      supervisorInstanceId: 'codex',
      workerInstanceIds: ['codex-2'],
      workerFinalVisibility: 'thread',
    });

    const workerVisibility = resolveOrchestratorWorkerVisibility({
      project,
      agentType: 'codex',
      instanceId: 'codex-2',
    });
    const supervisorVisibility = resolveOrchestratorWorkerVisibility({
      project,
      agentType: 'codex',
      instanceId: 'codex',
    });

    expect(workerVisibility).toBe('thread');
    expect(supervisorVisibility).toBeUndefined();
  });

  it('falls back to treat non-supervisor codex instance as worker when worker list is empty', () => {
    const project = createProjectWithOrchestrator({
      enabled: true,
      supervisorInstanceId: 'codex',
      workerInstanceIds: [],
      workerFinalVisibility: 'hidden',
    });

    const role = resolveOrchestratorRole({
      project,
      instanceId: 'codex-2',
      agentType: 'codex',
    });
    const visibility = resolveOrchestratorWorkerVisibility({
      project,
      agentType: 'codex',
      instanceId: 'codex-2',
    });

    expect(role).toBe('worker');
    expect(visibility).toBe('hidden');
  });
});
