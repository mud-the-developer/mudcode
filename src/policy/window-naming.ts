import type { BridgeConfig, ProjectState } from '../types/index.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';

export function toSharedWindowName(projectName: string, token: string): string {
  const raw = `${projectName}-${token}`;
  const safe = raw
    .replace(/[:\n\r\t]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : token;
}

export function toProjectScopedName(projectName: string, base: string, instanceId: string): string {
  if (instanceId === base) return toSharedWindowName(projectName, base);
  if (instanceId.startsWith(`${base}-`)) return toSharedWindowName(projectName, instanceId);
  return toSharedWindowName(projectName, `${base}-${instanceId}`);
}

export function buildRandomChannelInstanceName(length: number = 6): string {
  const safeLength = Math.max(4, Math.min(12, Math.trunc(length) || 6));
  let token = '';
  while (token.length < safeLength) {
    token += Math.random().toString(36).slice(2);
  }
  return token.slice(0, safeLength);
}

export function toProjectScopedChannelName(
  projectName: string,
  base: string,
  instanceId: string,
  channelInstanceName: string = buildRandomChannelInstanceName(),
  maxLength: number = 80,
): string {
  const scoped = toProjectScopedName(projectName, base, instanceId);
  const normalizedInstanceName = channelInstanceName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 12);
  const instanceToken = normalizedInstanceName.length > 0
    ? normalizedInstanceName
    : buildRandomChannelInstanceName();
  const suffix = `-${instanceToken}`;
  const resolvedMaxLength = Number.isFinite(maxLength)
    ? Math.max(suffix.length + 1, Math.trunc(maxLength))
    : 80;
  const scopedMaxLength = Math.max(1, resolvedMaxLength - suffix.length);
  const clippedScoped = scoped.slice(0, scopedMaxLength).replace(/[-_]+$/g, '');
  const prefix = clippedScoped.length > 0 ? clippedScoped : (scoped.slice(0, scopedMaxLength) || 'channel');
  return `${prefix}${suffix}`;
}

export function resolveProjectWindowName(
  project: ProjectState,
  agentName: string,
  tmuxConfig: BridgeConfig['tmux'],
  instanceId?: string,
): string {
  const normalized = normalizeProjectState(project);
  const mapped =
    (instanceId ? getProjectInstance(normalized, instanceId)?.tmuxWindow : undefined) ||
    getPrimaryInstanceForAgent(normalized, agentName)?.tmuxWindow ||
    project.tmuxWindows?.[agentName];
  if (mapped && mapped.length > 0) return mapped;

  const sharedSession = `${tmuxConfig.sessionPrefix}${tmuxConfig.sharedSessionName || 'bridge'}`;
  if (project.tmuxSession === sharedSession) {
    const token = instanceId || agentName;
    return toSharedWindowName(project.projectName, token);
  }
  return instanceId || agentName;
}
