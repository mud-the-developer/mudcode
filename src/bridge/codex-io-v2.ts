import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { MessagingClient } from '../messaging/interface.js';

export interface CodexIoV2TrackerDeps {
  messaging: MessagingClient;
  enabled?: boolean;
  announceCommandEvents?: boolean;
  rootDir?: string;
}

interface ActiveCommandState {
  sequence: number;
  command: string;
  startedAtMs: number;
}

interface TurnState {
  startedAtMs: number;
  commandsDetected: number;
  channelId?: string;
  activeCommand?: ActiveCommandState;
}

type CodexIoEvent =
  | {
      type: 'turn_start';
      ts: string;
      prompt: string;
    }
  | {
      type: 'turn_end';
      ts: string;
      reason: string;
      durationMs: number;
      commandsDetected: number;
    }
  | {
      type: 'turn_failed';
      ts: string;
      reason: string;
    }
  | {
      type: 'delta';
      ts: string;
      text: string;
    }
  | {
      type: 'command_start';
      ts: string;
      sequence: number;
      command: string;
    }
  | {
      type: 'command_end';
      ts: string;
      sequence: number;
      command: string;
      durationMs: number;
      exitCode?: number;
      reason: string;
    };

export class CodexIoV2Tracker {
  private readonly enabled: boolean;
  private readonly announceCommandEvents: boolean;
  private readonly rootDir: string;
  private readonly turnByInstance = new Map<string, TurnState>();
  private readonly latestLogPathByInstance = new Map<string, string>();

  constructor(private readonly deps: CodexIoV2TrackerDeps) {
    this.enabled = this.resolveEnabled(deps.enabled);
    this.announceCommandEvents = this.resolveAnnounceCommandEvents(deps.announceCommandEvents);
    this.rootDir = this.resolveRootDir(deps.rootDir);
  }

  recordPromptSubmitted(params: {
    projectName: string;
    instanceId: string;
    channelId?: string;
    prompt: string;
  }): void {
    if (!this.enabled) return;

    const key = this.instanceKey(params.projectName, params.instanceId);
    const now = Date.now();
    const state: TurnState = {
      startedAtMs: now,
      commandsDetected: 0,
      channelId: params.channelId?.trim() || undefined,
      activeCommand: undefined,
    };

    this.turnByInstance.set(key, state);
    this.appendEvent(params.projectName, params.instanceId, {
      type: 'turn_start',
      ts: new Date(now).toISOString(),
      prompt: params.prompt,
    });
  }

  recordOutputDelta(params: {
    projectName: string;
    instanceId: string;
    channelId?: string;
    deltaText: string;
  }): void {
    if (!this.enabled) return;

    const trimmed = params.deltaText.trim();
    if (trimmed.length === 0) return;

    const key = this.instanceKey(params.projectName, params.instanceId);
    const now = Date.now();
    const state = this.ensureTurnState(key, params.channelId, now);
    if (params.channelId && params.channelId.trim().length > 0) {
      state.channelId = params.channelId.trim();
    }

    this.appendEvent(params.projectName, params.instanceId, {
      type: 'delta',
      ts: new Date(now).toISOString(),
      text: trimmed,
    });

    for (const rawLine of trimmed.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      const command = this.detectCommandStart(line);
      if (command) {
        this.openCommand(params.projectName, params.instanceId, state, command, now);
        continue;
      }

      const exitCode = this.detectCommandExitCode(line);
      if (exitCode !== undefined) {
        this.closeActiveCommand(params.projectName, params.instanceId, state, now, 'exit-code-detected', exitCode);
      }
    }
  }

  recordTurnCompleted(params: {
    projectName: string;
    instanceId: string;
    channelId?: string;
    reason: string;
  }): void {
    if (!this.enabled) return;

    const key = this.instanceKey(params.projectName, params.instanceId);
    const state = this.turnByInstance.get(key);
    if (!state) return;

    const now = Date.now();
    if (params.channelId && params.channelId.trim().length > 0) {
      state.channelId = params.channelId.trim();
    }
    this.closeActiveCommand(params.projectName, params.instanceId, state, now, 'turn-completed');

    this.appendEvent(params.projectName, params.instanceId, {
      type: 'turn_end',
      ts: new Date(now).toISOString(),
      reason: params.reason,
      durationMs: Math.max(0, now - state.startedAtMs),
      commandsDetected: state.commandsDetected,
    });
    this.turnByInstance.delete(key);
  }

  recordTurnFailed(params: {
    projectName: string;
    instanceId: string;
    channelId?: string;
    reason: string;
  }): void {
    if (!this.enabled) return;

    const key = this.instanceKey(params.projectName, params.instanceId);
    const state = this.turnByInstance.get(key);
    if (!state) return;

    const now = Date.now();
    if (params.channelId && params.channelId.trim().length > 0) {
      state.channelId = params.channelId.trim();
    }
    this.closeActiveCommand(params.projectName, params.instanceId, state, now, 'turn-failed');
    this.appendEvent(params.projectName, params.instanceId, {
      type: 'turn_failed',
      ts: new Date(now).toISOString(),
      reason: params.reason,
    });
    this.turnByInstance.delete(key);
  }

  buildStatus(projectName: string, instanceId: string): string {
    if (!this.enabled) {
      return 'ℹ️ codex i/o v2 is disabled';
    }

    const key = this.instanceKey(projectName, instanceId);
    const state = this.turnByInstance.get(key);
    const latestLogPath = this.latestLogPathByInstance.get(key);

    if (!state) {
      return latestLogPath
        ? `🟢 i/o idle\nlatest transcript: \`${latestLogPath}\``
        : '🟢 i/o idle';
    }

    const ageMs = Math.max(0, Date.now() - state.startedAtMs);
    const activeCommand = state.activeCommand
      ? `\nactive command: #${state.activeCommand.sequence} \`${this.truncateInline(state.activeCommand.command, 120)}\``
      : '';
    const transcriptLine = latestLogPath ? `\ntranscript: \`${latestLogPath}\`` : '';

    return (
      `🟡 i/o active (${this.formatDuration(ageMs)}, commands detected: ${state.commandsDetected})` +
      `${activeCommand}` +
      `${transcriptLine}`
    );
  }

  getLatestLogPath(projectName: string, instanceId: string): string | undefined {
    return this.latestLogPathByInstance.get(this.instanceKey(projectName, instanceId));
  }

  private resolveEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;

    const raw = process.env.AGENT_DISCORD_CODEX_IO_V2;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveAnnounceCommandEvents(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;

    const raw = process.env.AGENT_DISCORD_CODEX_IO_V2_ANNOUNCE;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveRootDir(configured?: string): string {
    const fromInput = configured?.trim();
    if (fromInput && fromInput.length > 0) {
      return fromInput;
    }

    const fromEnv = process.env.AGENT_DISCORD_CODEX_IO_V2_DIR?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv;
    }

    return join(homedir(), '.mudcode', 'io-v2');
  }

  private ensureTurnState(key: string, channelId: string | undefined, now: number): TurnState {
    const existing = this.turnByInstance.get(key);
    if (existing) return existing;

    const created: TurnState = {
      startedAtMs: now,
      commandsDetected: 0,
      channelId: channelId?.trim() || undefined,
      activeCommand: undefined,
    };
    this.turnByInstance.set(key, created);
    return created;
  }

  private instanceKey(projectName: string, instanceId: string): string {
    return `${projectName}::${instanceId}`;
  }

  private appendEvent(projectName: string, instanceId: string, event: CodexIoEvent): void {
    const logPath = this.resolveLogPath(projectName, instanceId, event.ts);
    const payload = JSON.stringify(event);
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${payload}\n`);
      this.latestLogPathByInstance.set(this.instanceKey(projectName, instanceId), logPath);
    } catch (error) {
      console.warn(`Failed to write codex i/o transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveLogPath(projectName: string, instanceId: string, isoTs: string): string {
    const day = isoTs.slice(0, 10);
    const safeProject = this.safePathSegment(projectName);
    const safeInstance = this.safePathSegment(instanceId);
    return join(this.rootDir, safeProject, safeInstance, `${day}.jsonl`);
  }

  private safePathSegment(raw: string): string {
    const sanitized = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return sanitized.length > 0 ? sanitized : 'unknown';
  }

  private detectCommandStart(line: string): string | undefined {
    const trimmed = line.trim();
    if (trimmed.length < 3) return undefined;
    if (/^(assistant|system|user)\s*:/i.test(trimmed)) return undefined;

    const promptPrefix = trimmed.match(/^(?:\$|#)\s+(.+)$/);
    if (promptPrefix) return promptPrefix[1]!.trim();

    const runningBacktick = trimmed.match(/^(?:running|executing)\s+`([^`]+)`/i);
    if (runningBacktick) return runningBacktick[1]!.trim();

    const runningCommand = trimmed.match(/^(?:running|executing)(?:\s+shell)?\s+command\s*[:：]\s*(.+)$/i);
    if (runningCommand) return runningCommand[1]!.trim();

    return undefined;
  }

  private detectCommandExitCode(line: string): number | undefined {
    const match = line.match(
      /\b(?:exit(?:ed)?(?:\s+with)?\s+code|return(?:ed)?\s+code)\s*[:=]?\s*(-?\d+)\b/i,
    );
    if (!match) return undefined;

    const parsed = Number(match[1]);
    if (!Number.isInteger(parsed)) return undefined;
    return parsed;
  }

  private openCommand(
    projectName: string,
    instanceId: string,
    state: TurnState,
    command: string,
    now: number,
  ): void {
    this.closeActiveCommand(projectName, instanceId, state, now, 'preempted-by-next-command');

    const sequence = state.commandsDetected + 1;
    state.commandsDetected = sequence;
    const normalizedCommand = command.trim();
    const active: ActiveCommandState = {
      sequence,
      command: normalizedCommand,
      startedAtMs: now,
    };
    state.activeCommand = active;

    this.appendEvent(projectName, instanceId, {
      type: 'command_start',
      ts: new Date(now).toISOString(),
      sequence,
      command: normalizedCommand,
    });

    if (this.announceCommandEvents && state.channelId) {
      const preview = this.truncateInline(normalizedCommand, 220);
      void this.safeSend(state.channelId, `▶️ cmd#${sequence} \`${preview}\``);
    }
  }

  private closeActiveCommand(
    projectName: string,
    instanceId: string,
    state: TurnState,
    now: number,
    reason: string,
    exitCode?: number,
  ): void {
    const active = state.activeCommand;
    if (!active) return;

    state.activeCommand = undefined;
    const durationMs = Math.max(0, now - active.startedAtMs);
    this.appendEvent(projectName, instanceId, {
      type: 'command_end',
      ts: new Date(now).toISOString(),
      sequence: active.sequence,
      command: active.command,
      durationMs,
      exitCode,
      reason,
    });

    if (this.announceCommandEvents && state.channelId) {
      const exitLabel = exitCode === undefined ? 'unknown' : String(exitCode);
      const summary = `⏹️ cmd#${active.sequence} exit ${exitLabel} (${this.formatDuration(durationMs)})`;
      void this.safeSend(state.channelId, `${summary} \`${this.truncateInline(active.command, 140)}\``);
    }
  }

  private truncateInline(input: string, maxChars: number): string {
    const withoutNewlines = input.replace(/\s+/g, ' ').trim().replace(/`/g, "'");
    if (withoutNewlines.length <= maxChars) return withoutNewlines;
    return `${withoutNewlines.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
  }

  private async safeSend(channelId: string, content: string): Promise<void> {
    try {
      await this.deps.messaging.sendToChannel(channelId, content);
    } catch {
      // Non-critical telemetry channel message.
    }
  }
}
