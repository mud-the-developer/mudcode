import type { ProjectInstanceState, ProjectOrchestratorState, ProjectState } from '../types/index.js';

function sortInstances(a: ProjectInstanceState, b: ProjectInstanceState): number {
  return a.instanceId.localeCompare(b.instanceId);
}

function normalizeLegacyInstances(project: ProjectState): Record<string, ProjectInstanceState> {
  const keys = new Set<string>();

  for (const [agentType, enabled] of Object.entries(project.agents || {})) {
    if (enabled) keys.add(agentType);
  }
  for (const agentType of Object.keys(project.discordChannels || {})) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }
  for (const agentType of Object.keys(project.tmuxWindows || {})) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }
  for (const agentType of Object.keys(project.eventHooks || {})) {
    if (project.agents?.[agentType] === false) continue;
    keys.add(agentType);
  }

  const instances: Record<string, ProjectInstanceState> = {};
  for (const agentType of keys) {
    if (!agentType || agentType.trim().length === 0) continue;
    instances[agentType] = {
      instanceId: agentType,
      agentType,
      tmuxWindow: project.tmuxWindows?.[agentType],
      channelId: project.discordChannels?.[agentType],
      eventHook: project.eventHooks?.[agentType],
    };
  }

  return instances;
}

function normalizeInstanceMap(project: ProjectState): Record<string, ProjectInstanceState> {
  const instances = project.instances || {};
  const normalized: Record<string, ProjectInstanceState> = {};

  for (const [rawKey, rawValue] of Object.entries(instances)) {
    if (!rawValue || typeof rawValue !== 'object') continue;

    const instanceId =
      typeof rawValue.instanceId === 'string' && rawValue.instanceId.trim().length > 0
        ? rawValue.instanceId
        : rawKey;
    if (!instanceId || instanceId.trim().length === 0) continue;

    const agentType = typeof rawValue.agentType === 'string' ? rawValue.agentType.trim() : '';
    if (!agentType) continue;

    // Support both the current field name (`channelId`) and the legacy
    // field name (`discordChannelId`) for backward compatibility with
    // state files saved before the rename.
    const raw = rawValue as unknown as Record<string, unknown>;
    const rawChannelId = raw.channelId ?? raw.discordChannelId;
    const channelId = typeof rawChannelId === 'string' && rawChannelId.trim().length > 0
      ? rawChannelId
      : undefined;

    normalized[instanceId] = {
      instanceId,
      agentType,
      tmuxWindow: typeof rawValue.tmuxWindow === 'string' && rawValue.tmuxWindow.trim().length > 0
        ? rawValue.tmuxWindow
        : undefined,
      channelId: channelId,
      eventHook: typeof rawValue.eventHook === 'boolean' ? rawValue.eventHook : undefined,
    };
  }

  if (Object.keys(normalized).length > 0) return normalized;
  return normalizeLegacyInstances(project);
}

function deriveLegacyMaps(instances: Record<string, ProjectInstanceState>): Pick<ProjectState, 'agents' | 'discordChannels' | 'tmuxWindows' | 'eventHooks'> {
  const sorted = Object.values(instances).sort(sortInstances);

  const agents: ProjectState['agents'] = {};
  const discordChannels: ProjectState['discordChannels'] = {};
  const tmuxWindows: NonNullable<ProjectState['tmuxWindows']> = {};
  const eventHooks: NonNullable<ProjectState['eventHooks']> = {};

  for (const instance of sorted) {
    agents[instance.agentType] = true;

    if (instance.channelId && discordChannels[instance.agentType] === undefined) {
      discordChannels[instance.agentType] = instance.channelId;
    }
    if (instance.tmuxWindow && tmuxWindows[instance.agentType] === undefined) {
      tmuxWindows[instance.agentType] = instance.tmuxWindow;
    }
    if (typeof instance.eventHook === 'boolean' && eventHooks[instance.agentType] === undefined) {
      eventHooks[instance.agentType] = instance.eventHook;
    }
  }

  return {
    agents,
    discordChannels,
    tmuxWindows: Object.keys(tmuxWindows).length > 0 ? tmuxWindows : undefined,
    eventHooks: Object.keys(eventHooks).length > 0 ? eventHooks : undefined,
  };
}

function normalizeOrchestratorState(
  project: ProjectState,
  instances: Record<string, ProjectInstanceState>,
): ProjectOrchestratorState | undefined {
  const raw = project.orchestrator;
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.enabled !== true) return undefined;

  const knownInstanceIds = new Set(Object.keys(instances));
  const supervisorInstanceId =
    typeof raw.supervisorInstanceId === 'string' && knownInstanceIds.has(raw.supervisorInstanceId)
      ? raw.supervisorInstanceId
      : undefined;
  const workerInstanceIds = Array.isArray(raw.workerInstanceIds)
    ? [...new Set(raw.workerInstanceIds.filter((id): id is string => typeof id === 'string' && knownInstanceIds.has(id)))]
    : undefined;
  const workerFinalVisibility =
    raw.workerFinalVisibility === 'hidden' ||
    raw.workerFinalVisibility === 'thread' ||
    raw.workerFinalVisibility === 'channel'
      ? raw.workerFinalVisibility
      : 'hidden';

  const normalizeProgressDirective = (
    directive: unknown,
  ):
    | {
        mode?: 'off' | 'thread' | 'channel';
        blockStreamingEnabled?: boolean;
        blockWindowMs?: number;
        blockMaxChars?: number;
      }
    | undefined => {
    if (!directive || typeof directive !== 'object') return undefined;
    const rawDirective = directive as Record<string, unknown>;
    const next: {
      mode?: 'off' | 'thread' | 'channel';
      blockStreamingEnabled?: boolean;
      blockWindowMs?: number;
      blockMaxChars?: number;
    } = {};
    const modeRaw = rawDirective.mode;
    if (modeRaw === 'off' || modeRaw === 'thread' || modeRaw === 'channel') {
      next.mode = modeRaw;
    }
    if (typeof rawDirective.blockStreamingEnabled === 'boolean') {
      next.blockStreamingEnabled = rawDirective.blockStreamingEnabled;
    }
    if (
      typeof rawDirective.blockWindowMs === 'number' &&
      Number.isFinite(rawDirective.blockWindowMs) &&
      rawDirective.blockWindowMs >= 50 &&
      rawDirective.blockWindowMs <= 5000
    ) {
      next.blockWindowMs = Math.trunc(rawDirective.blockWindowMs);
    }
    if (
      typeof rawDirective.blockMaxChars === 'number' &&
      Number.isFinite(rawDirective.blockMaxChars) &&
      rawDirective.blockMaxChars >= 200 &&
      rawDirective.blockMaxChars <= 8000
    ) {
      next.blockMaxChars = Math.trunc(rawDirective.blockMaxChars);
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const normalizeDirectiveMap = (
    rawMap: unknown,
  ): Record<
    string,
    | {
        mode?: 'off' | 'thread' | 'channel';
        blockStreamingEnabled?: boolean;
        blockWindowMs?: number;
        blockMaxChars?: number;
      }
    | undefined
  > | undefined => {
    if (!rawMap || typeof rawMap !== 'object') return undefined;
    const entries = Object.entries(rawMap as Record<string, unknown>);
    const next: Record<
      string,
      | {
          mode?: 'off' | 'thread' | 'channel';
          blockStreamingEnabled?: boolean;
          blockWindowMs?: number;
          blockMaxChars?: number;
        }
      | undefined
    > = {};
    for (const [key, value] of entries) {
      if (!key || key.trim().length === 0) continue;
      const normalized = normalizeProgressDirective(value);
      if (normalized) {
        next[key] = normalized;
      }
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const progressPolicyRaw =
    raw.progressPolicy && typeof raw.progressPolicy === 'object'
      ? (raw.progressPolicy as Record<string, unknown>)
      : undefined;
  const progressDefault = normalizeProgressDirective(progressPolicyRaw?.default);
  const progressByChannelId = normalizeDirectiveMap(progressPolicyRaw?.byChannelId);
  const progressByInstanceId = normalizeDirectiveMap(progressPolicyRaw?.byInstanceId);
  const progressByAgentType = normalizeDirectiveMap(progressPolicyRaw?.byAgentType);
  const progressPolicy =
    progressDefault || progressByChannelId || progressByInstanceId || progressByAgentType
      ? {
          ...(progressDefault ? { default: progressDefault } : {}),
          ...(progressByChannelId ? { byChannelId: progressByChannelId } : {}),
          ...(progressByInstanceId ? { byInstanceId: progressByInstanceId } : {}),
          ...(progressByAgentType ? { byAgentType: progressByAgentType } : {}),
        }
      : undefined;

  const rawQos = raw.qos && typeof raw.qos === 'object' ? (raw.qos as Record<string, unknown>) : undefined;
  const maxConcurrentWorkers =
    typeof rawQos?.maxConcurrentWorkers === 'number' &&
    Number.isFinite(rawQos.maxConcurrentWorkers) &&
    rawQos.maxConcurrentWorkers >= 1 &&
    rawQos.maxConcurrentWorkers <= 16
      ? Math.trunc(rawQos.maxConcurrentWorkers)
      : undefined;
  const rawPriorities =
    rawQos?.workerPriorityByInstanceId && typeof rawQos.workerPriorityByInstanceId === 'object'
      ? (rawQos.workerPriorityByInstanceId as Record<string, unknown>)
      : undefined;
  const workerPriorityByInstanceId = rawPriorities
    ? Object.fromEntries(
        Object.entries(rawPriorities)
          .filter(([instanceId, priority]) =>
            knownInstanceIds.has(instanceId) &&
            typeof priority === 'number' &&
            Number.isFinite(priority) &&
            priority >= -10 &&
            priority <= 10,
          )
          .map(([instanceId, priority]) => [instanceId, Math.trunc(priority as number)]),
      )
    : undefined;
  const qos =
    maxConcurrentWorkers !== undefined ||
    (workerPriorityByInstanceId && Object.keys(workerPriorityByInstanceId).length > 0)
      ? {
          ...(maxConcurrentWorkers !== undefined ? { maxConcurrentWorkers } : {}),
          ...(workerPriorityByInstanceId && Object.keys(workerPriorityByInstanceId).length > 0
            ? { workerPriorityByInstanceId }
            : {}),
        }
      : undefined;

  const rawFinalFormat =
    raw.supervisorFinalFormat && typeof raw.supervisorFinalFormat === 'object'
      ? (raw.supervisorFinalFormat as Record<string, unknown>)
      : undefined;
  const supervisorFinalFormat =
    rawFinalFormat &&
    (typeof rawFinalFormat.enforce === 'boolean' ||
      (typeof rawFinalFormat.maxRetries === 'number' &&
        Number.isFinite(rawFinalFormat.maxRetries) &&
        rawFinalFormat.maxRetries >= 0 &&
        rawFinalFormat.maxRetries <= 10))
      ? {
          ...(typeof rawFinalFormat.enforce === 'boolean'
            ? { enforce: rawFinalFormat.enforce }
            : {}),
          ...(typeof rawFinalFormat.maxRetries === 'number' &&
          Number.isFinite(rawFinalFormat.maxRetries) &&
          rawFinalFormat.maxRetries >= 0 &&
          rawFinalFormat.maxRetries <= 10
            ? { maxRetries: Math.trunc(rawFinalFormat.maxRetries) }
            : {}),
        }
      : undefined;

  return {
    enabled: true,
    ...(supervisorInstanceId ? { supervisorInstanceId } : {}),
    ...(workerInstanceIds && workerInstanceIds.length > 0 ? { workerInstanceIds } : {}),
    workerFinalVisibility,
    ...(progressPolicy ? { progressPolicy } : {}),
    ...(qos ? { qos } : {}),
    ...(supervisorFinalFormat ? { supervisorFinalFormat } : {}),
  };
}

export function normalizeProjectState(project: ProjectState): ProjectState {
  const instances = normalizeInstanceMap(project);
  const legacy = deriveLegacyMaps(instances);
  const orchestrator = normalizeOrchestratorState(project, instances);

  return {
    ...project,
    instances,
    agents: legacy.agents,
    discordChannels: legacy.discordChannels,
    tmuxWindows: legacy.tmuxWindows,
    eventHooks: legacy.eventHooks,
    orchestrator,
  };
}

export function listProjectInstances(project: ProjectState): ProjectInstanceState[] {
  return Object.values(normalizeProjectState(project).instances || {})
    .filter((instance): instance is ProjectInstanceState => !!instance)
    .sort(sortInstances);
}

export function listProjectAgentTypes(project: ProjectState): string[] {
  return [...new Set(listProjectInstances(project).map((instance) => instance.agentType))];
}

export function getProjectInstance(project: ProjectState, instanceId: string): ProjectInstanceState | undefined {
  if (!instanceId) return undefined;
  return normalizeProjectState(project).instances?.[instanceId];
}

export function getPrimaryInstanceForAgent(project: ProjectState, agentType: string): ProjectInstanceState | undefined {
  return listProjectInstances(project).find((instance) => instance.agentType === agentType);
}

export function findProjectInstanceByChannel(project: ProjectState, channelId: string): ProjectInstanceState | undefined {
  if (!channelId) return undefined;
  return listProjectInstances(project).find(
    (instance) => instance.channelId === channelId,
  );
}

export function buildNextInstanceId(project: ProjectState | undefined, agentType: string): string {
  if (!project) return agentType;

  const taken = new Set(
    listProjectInstances(project)
      .filter((instance) => instance.agentType === agentType)
      .map((instance) => instance.instanceId),
  );

  if (!taken.has(agentType)) return agentType;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${agentType}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${agentType}-${Date.now()}`;
}
