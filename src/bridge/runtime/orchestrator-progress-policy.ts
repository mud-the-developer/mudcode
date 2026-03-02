import { getProjectInstance } from '../../state/instances.js';
import type { normalizeProjectState } from '../../state/instances.js';

export type EventProgressForwardMode = 'off' | 'thread' | 'channel';

export type ProgressPolicyDirective = {
  mode?: EventProgressForwardMode;
  blockStreamingEnabled?: boolean;
  blockWindowMs?: number;
  blockMaxChars?: number;
};

type NormalizedProjectState = ReturnType<typeof normalizeProjectState>;

export function resolveProgressPolicyDirective(params: {
  project: NormalizedProjectState;
  agentType: string;
  instanceId?: string;
  channelId?: string;
}): ProgressPolicyDirective {
  const policy = params.project.orchestrator?.progressPolicy;
  if (!policy) return {};

  const byAgentType = policy.byAgentType?.[params.agentType];
  const byInstanceId = params.instanceId ? policy.byInstanceId?.[params.instanceId] : undefined;
  const byChannelId = params.channelId ? policy.byChannelId?.[params.channelId] : undefined;
  return {
    ...(policy.default || {}),
    ...(byAgentType || {}),
    ...(byInstanceId || {}),
    ...(byChannelId || {}),
  };
}

export function resolveOrchestratorRole(params: {
  project: NormalizedProjectState;
  instanceId: string;
  agentType: string;
}): 'supervisor' | 'worker' | 'none' {
  const orchestrator = params.project.orchestrator;
  if (!orchestrator?.enabled) return 'none';
  if (orchestrator.supervisorInstanceId === params.instanceId) {
    return 'supervisor';
  }
  const workers = orchestrator.workerInstanceIds || [];
  if (workers.includes(params.instanceId)) {
    return 'worker';
  }
  if (workers.length === 0 && orchestrator.supervisorInstanceId && params.agentType === 'codex') {
    if (params.instanceId !== orchestrator.supervisorInstanceId) {
      return 'worker';
    }
  }
  return 'none';
}

export function resolveOrchestratorWorkerVisibility(params: {
  project: NormalizedProjectState;
  agentType: string;
  instanceId?: string;
}): 'hidden' | 'thread' | 'channel' | undefined {
  if (params.agentType !== 'codex' || !params.instanceId) return undefined;
  const orchestrator = params.project.orchestrator;
  if (!orchestrator?.enabled) return undefined;

  const visibility = orchestrator.workerFinalVisibility || 'hidden';
  const workers = orchestrator.workerInstanceIds || [];
  if (workers.includes(params.instanceId)) return visibility;

  // Backward-safe fallback when worker list is missing:
  // treat codex instances other than supervisor as workers.
  if (workers.length === 0 && orchestrator.supervisorInstanceId) {
    if (orchestrator.supervisorInstanceId === params.instanceId) return undefined;
    const instance = getProjectInstance(params.project, params.instanceId);
    return instance?.agentType === 'codex' ? visibility : undefined;
  }
  return undefined;
}
