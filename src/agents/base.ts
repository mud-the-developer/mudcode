/**
 * Base agent adapter interface
 * All AI agent CLIs must implement this interface
 */

import type { ICommandExecutor } from '../types/interfaces.js';
import { ShellCommandExecutor } from '../infra/shell.js';

export interface AgentConfig {
  name: string;
  displayName: string;
  command: string;
  channelSuffix: string;
}

export abstract class BaseAgentAdapter {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Check if the agent CLI is installed on this system
   */
  isInstalled(executor?: ICommandExecutor): boolean {
    const exec = executor || new ShellCommandExecutor();
    try {
      exec.execVoid(`command -v ${this.config.command}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the command to start this agent in a directory
   */
  getStartCommand(projectPath: string, _permissionAllow = false): string {
    return `cd "${projectPath}" && ${this.config.command}`;
  }

  /**
   * Parse channel name to check if it belongs to this agent
   */
  matchesChannel(channelName: string, projectName: string): boolean {
    return channelName === `${projectName}-${this.config.channelSuffix}`;
  }
}

export type AgentType = 'claude' | 'gemini' | 'opencode' | string;

/**
 * Registry for all available agent adapters
 */
export class AgentRegistry {
  private adapters: Map<AgentType, BaseAgentAdapter> = new Map();

  register(adapter: BaseAgentAdapter): void {
    this.adapters.set(adapter.config.name, adapter);
  }

  get(name: AgentType): BaseAgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getAll(): BaseAgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  getByChannelSuffix(suffix: string): BaseAgentAdapter | undefined {
    return this.getAll().find(a => a.config.channelSuffix === suffix);
  }

  parseChannelName(channelName: string): { projectName: string; agent: BaseAgentAdapter } | null {
    let bestMatch: { projectName: string; agent: BaseAgentAdapter; index: number } | null = null;

    for (const adapter of this.getAll()) {
      const marker = `-${adapter.config.channelSuffix}`;
      const index = channelName.lastIndexOf(marker);
      if (index <= 0) continue;

      const tailIndex = index + marker.length;
      const nextChar = channelName[tailIndex];
      if (tailIndex !== channelName.length && nextChar !== '-') continue;

      const projectName = channelName.slice(0, index);
      if (projectName.length === 0) continue;

      if (!bestMatch || index > bestMatch.index) {
        bestMatch = {
          projectName,
          agent: adapter,
          index,
        };
      }
    }

    if (bestMatch) {
      return {
        projectName: bestMatch.projectName,
        agent: bestMatch.agent,
      };
    }

    return null;
  }
}
