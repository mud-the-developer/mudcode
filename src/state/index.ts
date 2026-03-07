/**
 * Project state management
 * Tracks active projects, their Discord channels, and tmux sessions
 */

import { join } from 'path';
import { homedir } from 'os';
import type { IStorage, IStateManager } from '../types/interfaces.js';
import type { ProjectState as SharedProjectState } from '../types/index.js';
import { FileStorage } from '../infra/storage.js';
import { listProjectInstances, normalizeProjectState } from './instances.js';
import { perfMetrics } from '../observability/perf-metrics.js';

export type ProjectState = SharedProjectState;

export interface BridgeState {
  projects: Record<string, ProjectState>;
  guildId?: string;
  slackWorkspaceId?: string;
}


export class StateManager implements IStateManager {
  private state: BridgeState;
  private storage: IStorage;
  private stateDir: string;
  private stateFile: string;
  private pendingLastActiveSaveTimer?: ReturnType<typeof setTimeout>;
  private serializedStateCache = '';
  private channelLookupCache?: Map<string, { project: ProjectState; agentType: string }>;

  constructor(storage?: IStorage, stateDir?: string, stateFile?: string) {
    this.storage = storage || new FileStorage();
    this.stateDir = stateDir || join(homedir(), '.mudcode');
    this.stateFile = stateFile || join(this.stateDir, 'state.json');
    this.state = this.loadState();
    this.serializedStateCache = this.serializeState(this.state);
  }

  private loadState(): BridgeState {
    if (!this.storage.exists(this.stateFile)) {
      return { projects: {} };
    }
    try {
      const data = this.storage.readFile(this.stateFile, 'utf-8');
      const parsed = JSON.parse(data) as BridgeState;
      const projects: Record<string, ProjectState> = {};
      for (const [projectName, project] of Object.entries(parsed.projects || {})) {
        if (!project || typeof project !== 'object') continue;
        projects[projectName] = normalizeProjectState(project as ProjectState);
      }
      return {
        ...parsed,
        projects,
      };
    } catch {
      return { projects: {} };
    }
  }

  private serializeState(state: BridgeState): string {
    return JSON.stringify(state, null, 2);
  }

  private invalidateChannelLookupCache(): void {
    this.channelLookupCache = undefined;
  }

  private getChannelLookupCache(): Map<string, { project: ProjectState; agentType: string }> {
    if (this.channelLookupCache) return this.channelLookupCache;

    const lookup = new Map<string, { project: ProjectState; agentType: string }>();
    for (const project of Object.values(this.state.projects)) {
      for (const instance of listProjectInstances(project)) {
        const channelId = instance.channelId;
        if (!channelId || lookup.has(channelId)) continue;
        lookup.set(channelId, { project, agentType: instance.agentType });
      }
    }
    this.channelLookupCache = lookup;
    return lookup;
  }

  private saveState(): void {
    const nextSerialized = this.serializeState(this.state);
    if (nextSerialized === this.serializedStateCache) {
      return;
    }

    const stopStateSaveTimer = perfMetrics.startTimer('state_save_ms');
    try {
      if (!this.storage.exists(this.stateDir)) {
        this.storage.mkdirp(this.stateDir);
      }
      this.storage.writeFile(this.stateFile, nextSerialized);
      this.serializedStateCache = nextSerialized;
    } finally {
      stopStateSaveTimer();
    }
  }

  private resolveLastActiveSaveDebounceMs(): number {
    const raw = process.env.MUDCODE_STATE_LAST_ACTIVE_SAVE_DEBOUNCE_MS;
    if (!raw) return 1500;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1500;
    return Math.min(60_000, Math.max(100, Math.trunc(parsed)));
  }

  private clearPendingLastActiveSave(): void {
    if (!this.pendingLastActiveSaveTimer) return;
    clearTimeout(this.pendingLastActiveSaveTimer);
    this.pendingLastActiveSaveTimer = undefined;
  }

  private scheduleLastActiveSave(): void {
    if (this.pendingLastActiveSaveTimer) return;
    const delayMs = this.resolveLastActiveSaveDebounceMs();
    const timer = setTimeout(() => {
      this.pendingLastActiveSaveTimer = undefined;
      this.saveState();
    }, delayMs);
    timer.unref?.();
    this.pendingLastActiveSaveTimer = timer;
  }

  reload(): void {
    this.clearPendingLastActiveSave();
    this.state = this.loadState();
    this.serializedStateCache = this.serializeState(this.state);
    this.invalidateChannelLookupCache();
  }

  getProject(projectName: string): ProjectState | undefined {
    return this.state.projects[projectName];
  }

  setProject(project: ProjectState): void {
    this.state.projects[project.projectName] = normalizeProjectState(project);
    this.invalidateChannelLookupCache();
    this.clearPendingLastActiveSave();
    this.saveState();
  }

  removeProject(projectName: string): void {
    delete this.state.projects[projectName];
    this.invalidateChannelLookupCache();
    this.clearPendingLastActiveSave();
    this.saveState();
  }

  listProjects(): ProjectState[] {
    return Object.values(this.state.projects);
  }

  getGuildId(): string | undefined {
    return this.state.guildId;
  }

  setGuildId(guildId: string): void {
    this.state.guildId = guildId;
    this.clearPendingLastActiveSave();
    this.saveState();
  }

  getWorkspaceId(): string | undefined {
    return this.state.slackWorkspaceId || this.state.guildId;
  }

  setWorkspaceId(id: string): void {
    this.state.slackWorkspaceId = id;
    this.clearPendingLastActiveSave();
    this.saveState();
  }

  updateLastActive(projectName: string): void {
    if (this.state.projects[projectName]) {
      this.state.projects[projectName].lastActive = new Date();
      this.scheduleLastActiveSave();
    }
  }

  findProjectByChannel(channelId: string): ProjectState | undefined {
    return this.getChannelLookupCache().get(channelId)?.project;
  }

  getAgentTypeByChannel(channelId: string): string | undefined {
    return this.getChannelLookupCache().get(channelId)?.agentType;
  }
}

export const stateManager = new StateManager();
