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
  capturePollMs?: number;
  capturePendingQuietPolls?: number;
  capturePendingInitialQuietPollsCodex?: number;
  captureCodexFinalOnly?: boolean;
  captureStaleAlertMs?: number;
  captureFilterPromptEcho?: boolean;
  capturePromptEchoMaxPolls?: number;
  captureHistoryLines?: number;
  captureRedrawTailLines?: number;
  longOutputThreadThreshold?: number;
  captureProgressOutput?: 'off' | 'thread' | 'channel';
  keepChannelOnStop?: boolean;
  slackBotToken?: string;
  slackAppToken?: string;
  messagingPlatform?: 'discord' | 'slack';
}

const LONG_OUTPUT_THREAD_THRESHOLD_MIN = 1200;
const LONG_OUTPUT_THREAD_THRESHOLD_MAX = 20000;
const LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX = 100000;

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

      const storedConfig = this.migrateLegacyStoredLongOutputThreadThreshold(this.loadStoredConfig());
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
      const capturePollMs = this.resolveCaptureLineCount(
        storedConfig.capturePollMs,
        this.env.get('AGENT_DISCORD_CAPTURE_POLL_MS'),
        250,
        60000,
      );
      const capturePendingQuietPolls = this.resolveCaptureLineCount(
        storedConfig.capturePendingQuietPolls,
        this.env.get('AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS'),
        1,
        20,
      );
      const capturePendingInitialQuietPollsCodex = this.resolveCaptureLineCount(
        storedConfig.capturePendingInitialQuietPollsCodex,
        this.env.get('AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX'),
        0,
        20,
      );
      const captureCodexFinalOnly = this.resolveBooleanSetting(
        storedConfig.captureCodexFinalOnly,
        this.env.get('AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY'),
      );
      const captureStaleAlertMs = this.resolveCaptureLineCount(
        storedConfig.captureStaleAlertMs,
        this.env.get('AGENT_DISCORD_CAPTURE_STALE_ALERT_MS'),
        1000,
        3600000,
      );
      const captureFilterPromptEcho = this.resolveBooleanSetting(
        storedConfig.captureFilterPromptEcho,
        this.env.get('AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO'),
      );
      const capturePromptEchoMaxPolls = this.resolveCaptureLineCount(
        storedConfig.capturePromptEchoMaxPolls,
        this.env.get('AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS'),
        1,
        20,
      );
      const captureHistoryLines = this.resolveCaptureLineCount(
        storedConfig.captureHistoryLines,
        this.env.get('AGENT_DISCORD_CAPTURE_HISTORY_LINES'),
        300,
        4000,
      );
      const captureRedrawTailLines = this.resolveCaptureLineCount(
        storedConfig.captureRedrawTailLines,
        this.env.get('AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES'),
        40,
        300,
      );
      const longOutputThreadThreshold = this.resolveLongOutputThreadThreshold(
        storedConfig.longOutputThreadThreshold,
        this.env.get('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD'),
      );
      const captureProgressOutput = this.resolveCaptureProgressOutput(
        storedConfig.captureProgressOutput,
        this.env.get('AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT'),
      );
      const capture =
        capturePollMs !== undefined ||
        capturePendingQuietPolls !== undefined ||
        capturePendingInitialQuietPollsCodex !== undefined ||
        captureCodexFinalOnly !== undefined ||
        captureStaleAlertMs !== undefined ||
        captureFilterPromptEcho !== undefined ||
        capturePromptEchoMaxPolls !== undefined ||
        captureHistoryLines !== undefined ||
        captureRedrawTailLines !== undefined ||
        longOutputThreadThreshold !== undefined ||
        captureProgressOutput !== undefined
          ? {
              ...(capturePollMs !== undefined ? { pollMs: capturePollMs } : {}),
              ...(capturePendingQuietPolls !== undefined ? { pendingQuietPolls: capturePendingQuietPolls } : {}),
              ...(capturePendingInitialQuietPollsCodex !== undefined
                ? { pendingInitialQuietPollsCodex: capturePendingInitialQuietPollsCodex }
                : {}),
              ...(captureCodexFinalOnly !== undefined ? { codexFinalOnly: captureCodexFinalOnly } : {}),
              ...(captureStaleAlertMs !== undefined ? { staleAlertMs: captureStaleAlertMs } : {}),
              ...(captureFilterPromptEcho !== undefined ? { filterPromptEcho: captureFilterPromptEcho } : {}),
              ...(capturePromptEchoMaxPolls !== undefined ? { promptEchoMaxPolls: capturePromptEchoMaxPolls } : {}),
              ...(captureHistoryLines !== undefined ? { historyLines: captureHistoryLines } : {}),
              ...(captureRedrawTailLines !== undefined ? { redrawTailLines: captureRedrawTailLines } : {}),
              ...(longOutputThreadThreshold !== undefined ? { longOutputThreadThreshold } : {}),
              ...(captureProgressOutput !== undefined ? { progressOutput: captureProgressOutput } : {}),
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
        ...(capture ? { capture } : {}),
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

  private resolveCaptureLineCount(
    storedValue: unknown,
    envValue: string | undefined,
    min: number,
    max: number,
  ): number | undefined {
    const storedCandidate = this.parseCaptureLineCountCandidate(storedValue, min, max);
    if (storedCandidate !== undefined) return storedCandidate;
    return this.parseCaptureLineCountCandidate(envValue, min, max);
  }

  private resolveLongOutputThreadThreshold(
    storedValue: unknown,
    envValue: string | undefined,
  ): number | undefined {
    const storedCandidate = this.parseLongOutputThreadThresholdCandidate(storedValue, true);
    if (storedCandidate !== undefined) return storedCandidate;
    return this.parseLongOutputThreadThresholdCandidate(envValue, true);
  }

  private resolveBooleanSetting(
    storedValue: unknown,
    envValue: string | undefined,
  ): boolean | undefined {
    const storedCandidate = this.parseBooleanCandidate(storedValue);
    if (storedCandidate !== undefined) return storedCandidate;
    return this.parseBooleanCandidate(envValue);
  }

  private resolveCaptureProgressOutput(
    storedValue: unknown,
    envValue: string | undefined,
  ): 'off' | 'thread' | 'channel' | undefined {
    const storedCandidate = this.parseCaptureProgressOutputCandidate(storedValue);
    if (storedCandidate !== undefined) return storedCandidate;
    return this.parseCaptureProgressOutputCandidate(envValue);
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

  private parseCaptureLineCountCandidate(raw: unknown, min: number, max: number): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value)) return undefined;
    if (value < min || value > max) return undefined;
    return value;
  }

  private parseLongOutputThreadThresholdCandidate(raw: unknown, allowLegacyClamp: boolean): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value)) return undefined;
    if (value < LONG_OUTPUT_THREAD_THRESHOLD_MIN) return undefined;
    if (value <= LONG_OUTPUT_THREAD_THRESHOLD_MAX) return value;
    if (allowLegacyClamp && value <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX) {
      return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
    }
    return undefined;
  }

  private isLegacyLongOutputThreadThreshold(raw: unknown): boolean {
    if (raw === undefined || raw === null || raw === '') return false;
    const value = Number(raw);
    if (!Number.isInteger(value)) return false;
    return value > LONG_OUTPUT_THREAD_THRESHOLD_MAX && value <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX;
  }

  private migrateLegacyStoredLongOutputThreadThreshold(storedConfig: StoredConfig): StoredConfig {
    if (!this.isLegacyLongOutputThreadThreshold(storedConfig.longOutputThreadThreshold)) {
      return storedConfig;
    }

    try {
      this.saveConfig({ longOutputThreadThreshold: LONG_OUTPUT_THREAD_THRESHOLD_MAX });
    } catch {
      // Best-effort migration. Runtime will still use clamped value in-memory.
    }

    return {
      ...storedConfig,
      longOutputThreadThreshold: LONG_OUTPUT_THREAD_THRESHOLD_MAX,
    };
  }

  private parseBooleanCandidate(raw: unknown): boolean | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') {
      if (raw === 1) return true;
      if (raw === 0) return false;
      return undefined;
    }
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  }

  private parseCaptureProgressOutputCandidate(raw: unknown): 'off' | 'thread' | 'channel' | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
      return normalized;
    }
    return undefined;
  }

  private validateRawInputs(): void {
    const errors: string[] = [];
    const storedConfig = this.migrateLegacyStoredLongOutputThreadThreshold(this.loadStoredConfig());

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

    const rawStoredCaptureHistoryLines = storedConfig.captureHistoryLines;
    if (
      rawStoredCaptureHistoryLines !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCaptureHistoryLines, 300, 4000) === undefined
    ) {
      errors.push(
        `Stored captureHistoryLines must be an integer between 300 and 4000 (received: ${String(rawStoredCaptureHistoryLines)})`,
      );
    }

    const rawStoredCaptureRedrawTailLines = storedConfig.captureRedrawTailLines;
    if (
      rawStoredCaptureRedrawTailLines !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCaptureRedrawTailLines, 40, 300) === undefined
    ) {
      errors.push(
        `Stored captureRedrawTailLines must be an integer between 40 and 300 (received: ${String(rawStoredCaptureRedrawTailLines)})`,
      );
    }

    const rawStoredCapturePollMs = storedConfig.capturePollMs;
    if (
      rawStoredCapturePollMs !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCapturePollMs, 250, 60000) === undefined
    ) {
      errors.push(
        `Stored capturePollMs must be an integer between 250 and 60000 (received: ${String(rawStoredCapturePollMs)})`,
      );
    }

    const rawStoredCapturePendingQuietPolls = storedConfig.capturePendingQuietPolls;
    if (
      rawStoredCapturePendingQuietPolls !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCapturePendingQuietPolls, 1, 20) === undefined
    ) {
      errors.push(
        `Stored capturePendingQuietPolls must be an integer between 1 and 20 (received: ${String(rawStoredCapturePendingQuietPolls)})`,
      );
    }

    const rawStoredCapturePendingInitialQuietPollsCodex = storedConfig.capturePendingInitialQuietPollsCodex;
    if (
      rawStoredCapturePendingInitialQuietPollsCodex !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCapturePendingInitialQuietPollsCodex, 0, 20) === undefined
    ) {
      errors.push(
        `Stored capturePendingInitialQuietPollsCodex must be an integer between 0 and 20 (received: ${String(rawStoredCapturePendingInitialQuietPollsCodex)})`,
      );
    }

    if (
      storedConfig.captureCodexFinalOnly !== undefined &&
      this.parseBooleanCandidate(storedConfig.captureCodexFinalOnly) === undefined
    ) {
      errors.push(
        `Stored captureCodexFinalOnly must be a boolean (received: ${String(storedConfig.captureCodexFinalOnly)})`,
      );
    }

    const rawStoredCaptureStaleAlertMs = storedConfig.captureStaleAlertMs;
    if (
      rawStoredCaptureStaleAlertMs !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCaptureStaleAlertMs, 1000, 3600000) === undefined
    ) {
      errors.push(
        `Stored captureStaleAlertMs must be an integer between 1000 and 3600000 (received: ${String(rawStoredCaptureStaleAlertMs)})`,
      );
    }

    if (
      storedConfig.captureFilterPromptEcho !== undefined &&
      this.parseBooleanCandidate(storedConfig.captureFilterPromptEcho) === undefined
    ) {
      errors.push(
        `Stored captureFilterPromptEcho must be a boolean (received: ${String(storedConfig.captureFilterPromptEcho)})`,
      );
    }

    const rawStoredCapturePromptEchoMaxPolls = storedConfig.capturePromptEchoMaxPolls;
    if (
      rawStoredCapturePromptEchoMaxPolls !== undefined &&
      this.parseCaptureLineCountCandidate(rawStoredCapturePromptEchoMaxPolls, 1, 20) === undefined
    ) {
      errors.push(
        `Stored capturePromptEchoMaxPolls must be an integer between 1 and 20 (received: ${String(rawStoredCapturePromptEchoMaxPolls)})`,
      );
    }

    const rawStoredLongOutputThreadThreshold = storedConfig.longOutputThreadThreshold;
    if (
      rawStoredLongOutputThreadThreshold !== undefined &&
      this.parseLongOutputThreadThresholdCandidate(rawStoredLongOutputThreadThreshold, true) === undefined
    ) {
      errors.push(
        `Stored longOutputThreadThreshold must be an integer between ${LONG_OUTPUT_THREAD_THRESHOLD_MIN} and ${LONG_OUTPUT_THREAD_THRESHOLD_MAX} (received: ${String(rawStoredLongOutputThreadThreshold)})`,
      );
    }

    if (
      storedConfig.captureProgressOutput !== undefined &&
      this.parseCaptureProgressOutputCandidate(storedConfig.captureProgressOutput) === undefined
    ) {
      errors.push(
        `Stored captureProgressOutput must be "off", "thread", or "channel" (received: ${String(storedConfig.captureProgressOutput)})`,
      );
    }

    const rawEnvCaptureHistoryLines = this.env.get('AGENT_DISCORD_CAPTURE_HISTORY_LINES');
    if (rawEnvCaptureHistoryLines !== undefined && this.parseCaptureLineCountCandidate(rawEnvCaptureHistoryLines, 300, 4000) === undefined) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_HISTORY_LINES must be an integer between 300 and 4000 (received: ${rawEnvCaptureHistoryLines})`,
      );
    }

    const rawEnvCaptureRedrawTailLines = this.env.get('AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES');
    if (
      rawEnvCaptureRedrawTailLines !== undefined &&
      this.parseCaptureLineCountCandidate(rawEnvCaptureRedrawTailLines, 40, 300) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES must be an integer between 40 and 300 (received: ${rawEnvCaptureRedrawTailLines})`,
      );
    }

    const rawEnvCapturePollMs = this.env.get('AGENT_DISCORD_CAPTURE_POLL_MS');
    if (rawEnvCapturePollMs !== undefined && this.parseCaptureLineCountCandidate(rawEnvCapturePollMs, 250, 60000) === undefined) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_POLL_MS must be an integer between 250 and 60000 (received: ${rawEnvCapturePollMs})`,
      );
    }

    const rawEnvCapturePendingQuietPolls = this.env.get('AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS');
    if (
      rawEnvCapturePendingQuietPolls !== undefined &&
      this.parseCaptureLineCountCandidate(rawEnvCapturePendingQuietPolls, 1, 20) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS must be an integer between 1 and 20 (received: ${rawEnvCapturePendingQuietPolls})`,
      );
    }

    const rawEnvCapturePendingInitialQuietPollsCodex = this.env.get('AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX');
    if (
      rawEnvCapturePendingInitialQuietPollsCodex !== undefined &&
      this.parseCaptureLineCountCandidate(rawEnvCapturePendingInitialQuietPollsCodex, 0, 20) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX must be an integer between 0 and 20 (received: ${rawEnvCapturePendingInitialQuietPollsCodex})`,
      );
    }

    const rawEnvCaptureCodexFinalOnly = this.env.get('AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY');
    if (rawEnvCaptureCodexFinalOnly !== undefined && this.parseBooleanCandidate(rawEnvCaptureCodexFinalOnly) === undefined) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY must be boolean-like (true/false/1/0) (received: ${rawEnvCaptureCodexFinalOnly})`,
      );
    }

    const rawEnvCaptureStaleAlertMs = this.env.get('AGENT_DISCORD_CAPTURE_STALE_ALERT_MS');
    if (
      rawEnvCaptureStaleAlertMs !== undefined &&
      this.parseCaptureLineCountCandidate(rawEnvCaptureStaleAlertMs, 1000, 3600000) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_STALE_ALERT_MS must be an integer between 1000 and 3600000 (received: ${rawEnvCaptureStaleAlertMs})`,
      );
    }

    const rawEnvCaptureFilterPromptEcho = this.env.get('AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO');
    if (rawEnvCaptureFilterPromptEcho !== undefined && this.parseBooleanCandidate(rawEnvCaptureFilterPromptEcho) === undefined) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO must be boolean-like (true/false/1/0) (received: ${rawEnvCaptureFilterPromptEcho})`,
      );
    }

    const rawEnvCapturePromptEchoMaxPolls = this.env.get('AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS');
    if (
      rawEnvCapturePromptEchoMaxPolls !== undefined &&
      this.parseCaptureLineCountCandidate(rawEnvCapturePromptEchoMaxPolls, 1, 20) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS must be an integer between 1 and 20 (received: ${rawEnvCapturePromptEchoMaxPolls})`,
      );
    }

    const rawEnvLongOutputThreadThreshold = this.env.get('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD');
    if (
      rawEnvLongOutputThreadThreshold !== undefined &&
      this.parseLongOutputThreadThresholdCandidate(rawEnvLongOutputThreadThreshold, true) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD must be an integer between ${LONG_OUTPUT_THREAD_THRESHOLD_MIN} and ${LONG_OUTPUT_THREAD_THRESHOLD_MAX} (received: ${rawEnvLongOutputThreadThreshold})`,
      );
    }

    const rawEnvCaptureProgressOutput = this.env.get('AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT');
    if (
      rawEnvCaptureProgressOutput !== undefined &&
      this.parseCaptureProgressOutputCandidate(rawEnvCaptureProgressOutput) === undefined
    ) {
      errors.push(
        `AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT must be "off", "thread", or "channel" (received: ${rawEnvCaptureProgressOutput})`,
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
