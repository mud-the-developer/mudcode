/**
 * Project state management
 * Tracks active projects, their Discord channels, and tmux sessions
 */

import { join } from 'path';
import { homedir } from 'os';
import type { IStorage, IStateManager } from '../types/interfaces.js';
import type { ProjectState as SharedProjectState } from '../types/index.js';
import { FileStorage } from '../infra/storage.js';
import { findProjectInstanceByChannel, normalizeProjectState } from './instances.js';

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

  constructor(storage?: IStorage, stateDir?: string, stateFile?: string) {
    this.storage = storage || new FileStorage();
    this.stateDir = stateDir || join(homedir(), '.mudcode');
    this.stateFile = stateFile || join(this.stateDir, 'state.json');
    this.state = this.loadState();
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

  private saveState(): void {
    if (!this.storage.exists(this.stateDir)) {
      this.storage.mkdirp(this.stateDir);
    }
    this.storage.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
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
  }

  getProject(projectName: string): ProjectState | undefined {
    return this.state.projects[projectName];
  }

  setProject(project: ProjectState): void {
    this.state.projects[project.projectName] = normalizeProjectState(project);
    this.clearPendingLastActiveSave();
    this.saveState();
  }

  removeProject(projectName: string): void {
    delete this.state.projects[projectName];
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
    return Object.values(this.state.projects).find((project) => !!findProjectInstanceByChannel(project, channelId));
  }

  getAgentTypeByChannel(channelId: string): string | undefined {
    for (const project of Object.values(this.state.projects)) {
      const instance = findProjectInstanceByChannel(project, channelId);
      if (instance) return instance.agentType;
    }
    return undefined;
  }
}

export const stateManager = new StateManager();
