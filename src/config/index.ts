/**
 * Configuration management
 */

import { config as loadEnv } from 'dotenv';
import { join } from 'path';
import type { BridgeConfig, MessagingPlatform } from '../types/index.js';
import type { IStorage, IEnvironment } from '../types/interfaces.js';
import { FileStorage } from '../infra/storage.js';
import { SystemEnvironment } from '../infra/environment.js';
import { normalizeDiscordToken } from './token.js';

export interface StoredConfig {
  token?: string;
  serverId?: string;
  channelId?: string;
  hookServerPort?: number;
  defaultAgentCli?: string;
  opencodePermissionMode?: 'allow' | 'default';
  promptRefinerMode?: 'off' | 'shadow' | 'enforce';
  promptRefinerLogPath?: string;
  promptRefinerMaxLogChars?: number;
  keepChannelOnStop?: boolean;
  slackBotToken?: string;
  slackAppToken?: string;
  messagingPlatform?: 'discord' | 'slack';
}

export class ConfigManager {
  private storage: IStorage;
  private env: IEnvironment;
  private configDir: string;
  private configFile: string;
  private _config?: BridgeConfig;
  private envLoaded = false;

  constructor(storage?: IStorage, env?: IEnvironment, configDir?: string) {
    this.storage = storage || new FileStorage();
    this.env = env || new SystemEnvironment();
    this.configDir = configDir || join(this.env.homedir(), '.mudcode');
    this.configFile = join(this.configDir, 'config.json');
  }

  get config(): BridgeConfig {
    if (!this._config) {
      // Lazy load environment variables only once
      if (!this.envLoaded) {
        loadEnv();
        this.envLoaded = true;
      }

      const storedConfig = this.loadStoredConfig();
      const storedToken = normalizeDiscordToken(storedConfig.token);
      const envToken = normalizeDiscordToken(this.env.get('DISCORD_BOT_TOKEN'));
      const envPermissionModeRaw = this.env.get('OPENCODE_PERMISSION_MODE');
      const envPermissionMode =
        envPermissionModeRaw === 'allow' || envPermissionModeRaw === 'default'
          ? envPermissionModeRaw
          : undefined;
      const opencodePermissionMode = storedConfig.opencodePermissionMode || envPermissionMode;
      const defaultAgentCli = storedConfig.defaultAgentCli || this.env.get('MUDCODE_DEFAULT_AGENT_CLI');

      const platformRaw = storedConfig.messagingPlatform || this.env.get('MESSAGING_PLATFORM');
      const messagingPlatform: MessagingPlatform | undefined =
        platformRaw === 'slack' ? 'slack' : platformRaw === 'discord' ? 'discord' : undefined;
      const envPromptRefinerModeRaw = this.env.get('MUDCODE_PROMPT_REFINER_MODE');
      const envPromptRefinerMode = this.parsePromptRefinerModeCandidate(envPromptRefinerModeRaw);
      const promptRefinerMode =
        this.parsePromptRefinerModeCandidate(storedConfig.promptRefinerMode) || envPromptRefinerMode;
      const promptRefinerLogPath = storedConfig.promptRefinerLogPath || this.env.get('MUDCODE_PROMPT_REFINER_LOG_PATH');
      const promptRefinerMaxLogChars = this.resolvePromptRefinerMaxLogChars(
        storedConfig.promptRefinerMaxLogChars,
        this.env.get('MUDCODE_PROMPT_REFINER_MAX_LOG_CHARS'),
      );
      const promptRefiner =
        promptRefinerMode || promptRefinerLogPath || promptRefinerMaxLogChars !== undefined
          ? {
              ...(promptRefinerMode ? { mode: promptRefinerMode } : {}),
              ...(promptRefinerLogPath ? { logPath: promptRefinerLogPath } : {}),
              ...(promptRefinerMaxLogChars !== undefined ? { maxLogChars: promptRefinerMaxLogChars } : {}),
            }
          : undefined;

      const slackBotToken = storedConfig.slackBotToken || this.env.get('SLACK_BOT_TOKEN');
      const slackAppToken = storedConfig.slackAppToken || this.env.get('SLACK_APP_TOKEN');

      // Merge: stored config > environment variables > defaults
      const resolvedHookPort = this.resolveHookServerPort(
        storedConfig.hookServerPort,
        this.env.get('HOOK_SERVER_PORT'),
      );
      this._config = {
        discord: {
          token: storedToken || envToken || '',
          channelId: storedConfig.channelId || this.env.get('DISCORD_CHANNEL_ID'),
          guildId: storedConfig.serverId || this.env.get('DISCORD_GUILD_ID'),
        },
        ...(slackBotToken && slackAppToken
          ? { slack: { botToken: slackBotToken, appToken: slackAppToken } }
          : {}),
        ...(messagingPlatform ? { messagingPlatform } : {}),
        tmux: {
          sessionPrefix: this.env.get('TMUX_SESSION_PREFIX') || '',
          sharedSessionName: this.env.get('TMUX_SHARED_SESSION_NAME') || 'bridge',
        },
        hookServerPort: resolvedHookPort,
        ...(defaultAgentCli ? { defaultAgentCli } : {}),
        ...(promptRefiner ? { promptRefiner } : {}),
        opencode: opencodePermissionMode
          ? { permissionMode: opencodePermissionMode }
          : undefined,
      };
    }
    return this._config;
  }

  loadStoredConfig(): StoredConfig {
    if (!this.storage.exists(this.configFile)) {
      return {};
    }
    try {
      const data = this.storage.readFile(this.configFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  saveConfig(updates: Partial<StoredConfig>): void {
    if (!this.storage.exists(this.configDir)) {
      this.storage.mkdirp(this.configDir);
    }

    const normalizedUpdates: Partial<StoredConfig> = {
      ...updates,
      ...(updates.token !== undefined ? { token: normalizeDiscordToken(updates.token) } : {}),
    };

    const current = this.loadStoredConfig();
    const newConfig = { ...current, ...normalizedUpdates };
    this.storage.writeFile(this.configFile, JSON.stringify(newConfig, null, 2));
    this.storage.chmod(this.configFile, 0o600);

    // Invalidate cached config
    this._config = undefined;
  }

  getConfigValue<K extends keyof StoredConfig>(key: K): StoredConfig[K] {
    const stored = this.loadStoredConfig();
    return stored[key];
  }

  validateConfig(): void {
    this.validateRawInputs();

    if (this.config.messagingPlatform === 'slack') {
      if (!this.config.slack?.botToken || !this.config.slack?.appToken) {
        throw new Error(
          'Slack tokens not configured.\n' +
          'Run: mudcode onboard --platform slack\n' +
          'Or set SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables'
        );
      }
    } else {
      if (!this.config.discord.token) {
        throw new Error(
          'Discord bot token not configured.\n' +
          'Run: mudcode config --token <your-token>\n' +
          'Or set DISCORD_BOT_TOKEN environment variable'
        );
      }
    }
  }

  private resolveHookServerPort(storedPort: unknown, envPortRaw: string | undefined): number {
    const storedCandidate = this.parsePortCandidate(storedPort);
    if (storedCandidate !== undefined) {
      return storedCandidate;
    }

    const envCandidate = this.parsePortCandidate(envPortRaw);
    if (envCandidate !== undefined) {
      return envCandidate;
    }

    return 18470;
  }

  private parsePortCandidate(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;

    if (typeof raw === 'number') {
      if (!Number.isInteger(raw)) return undefined;
      if (raw < 1 || raw > 65535) return undefined;
      return raw;
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) return undefined;
      const parsed = parseInt(trimmed, 10);
      if (parsed < 1 || parsed > 65535) return undefined;
      return parsed;
    }

    return undefined;
  }

  private resolvePromptRefinerMaxLogChars(storedValue: unknown, envValue: string | undefined): number | undefined {
    const storedCandidate = this.parsePromptRefinerMaxLogCharsCandidate(storedValue);
    if (storedCandidate !== undefined) return storedCandidate;
    return this.parsePromptRefinerMaxLogCharsCandidate(envValue);
  }

  private parsePromptRefinerModeCandidate(raw: unknown): 'off' | 'shadow' | 'enforce' | undefined {
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'shadow' || normalized === 'enforce') {
      return normalized;
    }
    return undefined;
  }

  private parsePromptRefinerMaxLogCharsCandidate(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value)) return undefined;
    if (value < 500 || value > 200000) return undefined;
    return value;
  }

  private validateRawInputs(): void {
    const errors: string[] = [];
    const storedConfig = this.loadStoredConfig();

    const rawPlatform = storedConfig.messagingPlatform || this.env.get('MESSAGING_PLATFORM');
    if (rawPlatform && rawPlatform !== 'discord' && rawPlatform !== 'slack') {
      errors.push(
        `MESSAGING_PLATFORM must be "discord" or "slack" (received: ${rawPlatform})`,
      );
    }

    const envPermissionMode = this.env.get('OPENCODE_PERMISSION_MODE');
    if (envPermissionMode && envPermissionMode !== 'allow' && envPermissionMode !== 'default') {
      errors.push(
        `OPENCODE_PERMISSION_MODE must be "allow" or "default" (received: ${envPermissionMode})`,
      );
    }

    const envPromptRefinerMode = this.env.get('MUDCODE_PROMPT_REFINER_MODE');
    if (envPromptRefinerMode && this.parsePromptRefinerModeCandidate(envPromptRefinerMode) === undefined) {
      errors.push(
        `MUDCODE_PROMPT_REFINER_MODE must be "off", "shadow", or "enforce" (received: ${envPromptRefinerMode})`,
      );
    }

    if (
      storedConfig.promptRefinerMode !== undefined &&
      this.parsePromptRefinerModeCandidate(storedConfig.promptRefinerMode) === undefined
    ) {
      errors.push(
        `Stored promptRefinerMode must be "off", "shadow", or "enforce" (received: ${String(storedConfig.promptRefinerMode)})`,
      );
    }

    const rawStoredRefinerMax = storedConfig.promptRefinerMaxLogChars;
    if (
      rawStoredRefinerMax !== undefined &&
      this.parsePromptRefinerMaxLogCharsCandidate(rawStoredRefinerMax) === undefined
    ) {
      errors.push(
        `Stored promptRefinerMaxLogChars must be an integer between 500 and 200000 (received: ${String(rawStoredRefinerMax)})`,
      );
    }

    const rawEnvRefinerMax = this.env.get('MUDCODE_PROMPT_REFINER_MAX_LOG_CHARS');
    if (rawEnvRefinerMax !== undefined && this.parsePromptRefinerMaxLogCharsCandidate(rawEnvRefinerMax) === undefined) {
      errors.push(
        `MUDCODE_PROMPT_REFINER_MAX_LOG_CHARS must be an integer between 500 and 200000 (received: ${rawEnvRefinerMax})`,
      );
    }

    const rawStoredPort = storedConfig.hookServerPort;
    if (rawStoredPort !== undefined && this.parsePortCandidate(rawStoredPort) === undefined) {
      errors.push(
        `Stored hookServerPort must be an integer between 1 and 65535 (received: ${String(rawStoredPort)})`,
      );
    }

    const rawEnvPort = this.env.get('HOOK_SERVER_PORT');
    if (rawEnvPort !== undefined && this.parsePortCandidate(rawEnvPort) === undefined) {
      errors.push(
        `HOOK_SERVER_PORT must be an integer between 1 and 65535 (received: ${rawEnvPort})`,
      );
    }

    const effectivePlatform = rawPlatform === 'slack' ? 'slack' : 'discord';
    if (effectivePlatform === 'slack') {
      const slackBotToken = storedConfig.slackBotToken || this.env.get('SLACK_BOT_TOKEN');
      const slackAppToken = storedConfig.slackAppToken || this.env.get('SLACK_APP_TOKEN');
      if (slackBotToken && !slackBotToken.startsWith('xoxb-')) {
        errors.push('SLACK_BOT_TOKEN must start with "xoxb-"');
      }
      if (slackAppToken && !slackAppToken.startsWith('xapp-')) {
        errors.push('SLACK_APP_TOKEN must start with "xapp-"');
      }
    }

    if (errors.length > 0) {
      throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
    }
  }

  getConfigPath(): string {
    return this.configFile;
  }

  resetConfig(): void {
    this._config = undefined;
    this.envLoaded = false;
  }
}

// Default instance for backward compatibility
const defaultConfigManager = new ConfigManager();

// Backward-compatible exports using Proxy for lazy initialization
export const config: BridgeConfig = new Proxy({} as BridgeConfig, {
  get(_target, prop) {
    return (defaultConfigManager.config as any)[prop];
  }
});

export function saveConfig(updates: Partial<StoredConfig>): void {
  defaultConfigManager.saveConfig(updates);
}

export function getConfigValue<K extends keyof StoredConfig>(key: K): StoredConfig[K] {
  return defaultConfigManager.getConfigValue(key);
}

export function validateConfig(): void {
  defaultConfigManager.validateConfig();
}

export function getConfigPath(): string {
  return defaultConfigManager.getConfigPath();
}
