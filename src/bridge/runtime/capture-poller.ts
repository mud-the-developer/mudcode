import { cleanCapture, splitForDiscord, splitForSlack } from '../../capture/parser.js';
import type { MessagingClient } from '../../messaging/interface.js';
import { getProjectInstance, listProjectInstances, normalizeProjectState } from '../../state/instances.js';
import { TmuxManager } from '../../tmux/manager.js';
import type { IStateManager } from '../../types/interfaces.js';
import type { ProjectState } from '../../types/index.js';
import { PendingMessageTracker, type PendingRouteSnapshot } from './pending-message-tracker.js';
import { formatDiscordOutput, wrapDiscordCodeblock } from '../formatting/discord-output-formatter.js';
import type { CodexIoV2Tracker } from '../events/codex-io-v2.js';
import type { AgentEventHookClient } from '../events/agent-event-hook.js';
import {
  resolveOrchestratorWorkerVisibility,
  resolveProgressPolicyDirective,
} from './orchestrator-progress-policy.js';
import { perfMetrics } from '../../observability/perf-metrics.js';

type ProgressOutputVisibility = 'off' | 'thread' | 'channel';
type EventProgressMode = 'off' | 'thread' | 'channel';
type OutputEventType = 'progress' | 'final';
type DeltaDeliveryResult = { observedOutput: boolean; emittedOutput: boolean };
type ProgressBatchEntry = {
  text: string;
  channelId?: string;
  outputVisibility?: ProgressOutputVisibility;
  agentType: string;
};
type ProgressHookBurstState = {
  turnId?: string;
  emittedCount: number;
  suppressedCount: number;
  updatedAtMs: number;
};
type RawCaptureSnapshot = {
  raw: string;
  cleaned: string;
};

const LONG_OUTPUT_THREAD_THRESHOLD_MIN = 1200;
const LONG_OUTPUT_THREAD_THRESHOLD_MAX = 20000;
const LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX = 100000;
const FINAL_ONLY_BUFFER_MAX_CHARS_MIN = 4000;
const FINAL_ONLY_BUFFER_MAX_CHARS_MAX = 500000;
const DEFAULT_FINAL_ONLY_BUFFER_MAX_CHARS = 120000;
const DEFAULT_DEAD_WORKER_MISSING_POLL_THRESHOLD = 6;
const DISCORD_OUTPUT_MAX_CHUNKS_DEFAULT = 4;
const DISCORD_OUTPUT_MAX_CHUNKS_MIN = 1;
const DISCORD_OUTPUT_MAX_CHUNKS_MAX = 40;

export interface BridgeCapturePollerDeps {
  messaging: MessagingClient;
  tmux: TmuxManager;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  ioTracker?: CodexIoV2Tracker;
  eventHookClient?: AgentEventHookClient;
  eventLifecycleStaleChecker?: (projectName: string, instanceId: string, agentType: string) => boolean;
  intervalMs?: number;
  quietPendingPollThreshold?: number;
  codexInitialQuietPendingPollThreshold?: number;
  codexFinalOnlyModeEnabled?: boolean;
  longOutputThreadThreshold?: number;
  stalePendingAlertMs?: number;
  promptEchoFilterEnabled?: boolean;
  promptEchoSuppressionMaxPolls?: number;
  redrawFallbackTailLines?: number;
  progressOutputVisibility?: ProgressOutputVisibility;
  codexProgressHookMinIntervalMs?: number;
  finalOnlyBufferMaxChars?: number;
}

export class BridgeCapturePoller {
  private readonly intervalMs: number;
  private readonly quietPendingPollThreshold: number;
  private readonly codexInitialQuietPendingPollThreshold: number;
  private readonly codexFinalOnlyModeEnabled: boolean;
  private readonly codexForceEventOutputEnabled: boolean;
  private readonly longOutputThreadThreshold: number;
  private readonly stalePendingAlertMs: number;
  private readonly stalePendingAutoRecoverEnabled: boolean;
  private readonly promptEchoFilterEnabled: boolean;
  private readonly promptEchoSuppressionMaxPolls: number;
  private readonly redrawFallbackTailLines: number;
  private readonly progressOutputVisibility: ProgressOutputVisibility;
  private readonly codexProgressHookMinIntervalMs: number;
  private readonly codexProgressHookMaxMessagesPerTurn: number;
  private readonly finalOnlyBufferMaxChars: number;
  private readonly progressDuplicateWindowMs: number;
  private readonly progressBatchEnabled: boolean;
  private readonly progressBatchMaxChars: number;
  private readonly eventHookCaptureFallbackStaleGraceMs: number;
  private readonly eventHookCaptureOutputEnabled: boolean;
  private readonly codexEventProgressMode?: EventProgressMode;
  private readonly codexEventProgressBlockStreaming?: boolean;
  private readonly codexEventProgressBlockWindowMs?: number;
  private readonly codexEventProgressBlockMaxChars?: number;
  private readonly idleRefreshPolls: number;
  private readonly idleRefreshMaxPolls: number;
  private readonly idleRefreshBackoffMaxSteps: number;
  private readonly deadWorkerMissingPollThreshold: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private snapshotsByInstance = new Map<string, string>();
  private lastCaptureMutationAtByInstance = new Map<string, number>();
  private stalePendingAlertStageByInstance = new Map<string, number>();
  private stalePendingAutoRecoveredBaselineByInstance = new Map<string, number>();
  private completionCandidatesByInstance = new Map<
    string,
    { projectName: string; agentType: string; instanceId: string }
  >();
  private quietPendingPollsByInstance = new Map<
    string,
    { count: number; projectName: string; agentType: string; instanceId: string }
  >();
  private finalOnlyQuietFlushPollsByInstance = new Map<string, number>();
  private promptEchoSuppressedPollsByInstance = new Map<string, number>();
  private bufferedOutputByInstance = new Map<string, string>();
  private bufferedOutputChannelByInstance = new Map<string, string>();
  private lastPendingTurnIdByInstance = new Map<string, string>();
  private supervisorFinalFormatRetryStateByInstance = new Map<string, { count: number; lastTurnId?: string }>();
  private progressHookHeartbeatByInstance = new Map<string, { atMs: number; turnId?: string }>();
  private progressHookInFlightByInstance = new Set<string>();
  private progressHookBurstByInstance = new Map<string, ProgressHookBurstState>();
  private codexFinalHookTurnByInstance = new Map<string, string>();
  private eventHookFallbackActiveByInstance = new Set<string>();
  private eventHookStaleSinceByInstance = new Map<string, number>();
  private idleSkipPollsByInstance = new Map<string, number>();
  private idleSkipBackoffByInstance = new Map<string, number>();
  private rawCaptureSnapshotByInstance = new Map<string, RawCaptureSnapshot>();
  private missingWorkerWindowPollsByInstance = new Map<string, number>();
  private lastProgressOutputByRoute = new Map<string, { text: string; atMs: number }>();
  private progressBatchByInstance = new Map<string, ProgressBatchEntry>();

  constructor(private deps: BridgeCapturePollerDeps) {
    this.intervalMs = this.resolveIntervalMs(deps.intervalMs);
    this.quietPendingPollThreshold = this.resolveQuietPendingPollThreshold(deps.quietPendingPollThreshold);
    this.codexInitialQuietPendingPollThreshold = this.resolveCodexInitialQuietPendingPollThreshold(
      deps.codexInitialQuietPendingPollThreshold,
    );
    this.codexFinalOnlyModeEnabled = this.resolveCodexFinalOnlyModeEnabled(deps.codexFinalOnlyModeEnabled);
    this.codexForceEventOutputEnabled = this.resolveCodexForceEventOutputEnabled();
    this.longOutputThreadThreshold = this.resolveLongOutputThreadThreshold(deps.longOutputThreadThreshold);
    this.stalePendingAlertMs = this.resolveStalePendingAlertMs(deps.stalePendingAlertMs);
    this.stalePendingAutoRecoverEnabled = this.resolveStalePendingAutoRecoverEnabled();
    this.promptEchoFilterEnabled = this.resolvePromptEchoFilterEnabled(deps.promptEchoFilterEnabled);
    this.promptEchoSuppressionMaxPolls = this.resolvePromptEchoSuppressionMaxPolls(deps.promptEchoSuppressionMaxPolls);
    this.redrawFallbackTailLines = this.resolveRedrawFallbackTailLines(deps.redrawFallbackTailLines);
    this.progressOutputVisibility = this.resolveProgressOutputVisibility(deps.progressOutputVisibility);
    this.codexProgressHookMinIntervalMs = this.resolveCodexProgressHookMinIntervalMs(
      deps.codexProgressHookMinIntervalMs,
    );
    this.codexProgressHookMaxMessagesPerTurn = this.resolveCodexProgressHookMaxMessagesPerTurn();
    this.finalOnlyBufferMaxChars = this.resolveFinalOnlyBufferMaxChars(deps.finalOnlyBufferMaxChars);
    this.progressDuplicateWindowMs = this.resolveProgressDuplicateWindowMs();
    this.progressBatchEnabled = this.resolveProgressBatchEnabled();
    this.progressBatchMaxChars = this.resolveProgressBatchMaxChars();
    this.eventHookCaptureFallbackStaleGraceMs = this.resolveEventHookCaptureFallbackStaleGraceMs();
    this.eventHookCaptureOutputEnabled = this.resolveEventHookCaptureOutputEnabled();
    this.codexEventProgressMode = this.resolveCodexEventProgressMode();
    this.codexEventProgressBlockStreaming = this.resolveCodexEventProgressBlockStreaming();
    this.codexEventProgressBlockWindowMs = this.resolveCodexEventProgressBlockWindowMs();
    this.codexEventProgressBlockMaxChars = this.resolveCodexEventProgressBlockMaxChars();
    this.idleRefreshPolls = this.resolveIdleRefreshPolls();
    this.idleRefreshMaxPolls = this.resolveIdleRefreshMaxPolls();
    this.idleRefreshBackoffMaxSteps = this.resolveIdleRefreshBackoffMaxSteps();
    this.deadWorkerMissingPollThreshold = this.resolveDeadWorkerMissingPollThreshold();
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);

    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    this.lastCaptureMutationAtByInstance.clear();
    this.stalePendingAlertStageByInstance.clear();
    this.stalePendingAutoRecoveredBaselineByInstance.clear();
    this.completionCandidatesByInstance.clear();
    this.quietPendingPollsByInstance.clear();
    this.finalOnlyQuietFlushPollsByInstance.clear();
    this.promptEchoSuppressedPollsByInstance.clear();
    this.bufferedOutputByInstance.clear();
    this.bufferedOutputChannelByInstance.clear();
    this.lastPendingTurnIdByInstance.clear();
    this.supervisorFinalFormatRetryStateByInstance.clear();
    this.progressHookHeartbeatByInstance.clear();
    this.progressHookInFlightByInstance.clear();
    this.progressHookBurstByInstance.clear();
    this.codexFinalHookTurnByInstance.clear();
    this.eventHookFallbackActiveByInstance.clear();
    this.eventHookStaleSinceByInstance.clear();
    this.idleSkipPollsByInstance.clear();
    this.idleSkipBackoffByInstance.clear();
    this.rawCaptureSnapshotByInstance.clear();
    this.missingWorkerWindowPollsByInstance.clear();
    this.lastProgressOutputByRoute.clear();
    this.progressBatchByInstance.clear();
  }

  private resolveIntervalMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 250) {
      return Math.trunc(configured);
    }

    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_POLL_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 250) {
      return Math.trunc(fromEnv);
    }

    return 3000;
  }

  private resolveQuietPendingPollThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1) {
      return Math.trunc(fromEnv);
    }
    return 2;
  }

  private resolveCodexInitialQuietPendingPollThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0) {
      return Math.trunc(fromEnv);
    }
    // Default: do not auto-complete codex pending before first visible output.
    // This avoids showing ✅ too early when codex is still thinking silently.
    return 0;
  }

  private resolveCodexFinalOnlyModeEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;
    const raw = process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveCodexForceEventOutputEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveProgressDuplicateWindowMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PROGRESS_DEDUPE_WINDOW_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 60_000) {
      return Math.trunc(fromEnv);
    }
    return 2500;
  }

  private resolveProgressBatchEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_ENABLED;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveProgressBatchMaxChars(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PROGRESS_BATCH_MAX_CHARS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 400 && fromEnv <= 20_000) {
      return Math.trunc(fromEnv);
    }
    return 2600;
  }

  private isCodexEventOnlyActive(agentType: string): boolean {
    if (agentType !== 'codex') return false;
    if (this.deps.eventHookClient?.enabled !== true) return false;
    // Stage B: codex lifecycle is enforced event-only whenever hook bridge is active.
    return true;
  }

  private isCodexEventOutputAuthoritative(agentType: string): boolean {
    if (agentType !== 'codex') return false;
    if (this.deps.eventHookClient?.enabled !== true) return false;
    return this.codexForceEventOutputEnabled;
  }

  private isEventHookDrivenInstance(agentType: string, persistedEventHook?: boolean): boolean {
    // Codex still derives lifecycle events from tmux capture and posts them via local event-hook bridge.
    // Keep capture polling enabled for codex regardless of persisted eventHook state.
    if (agentType === 'codex') return false;
    return persistedEventHook === true;
  }

  private resolveLongOutputThreadThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= LONG_OUTPUT_THREAD_THRESHOLD_MIN) {
      const normalized = Math.trunc(configured);
      if (normalized <= LONG_OUTPUT_THREAD_THRESHOLD_MAX) return normalized;
      if (normalized <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX) return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
      return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD || '');
    if (Number.isFinite(fromEnv) && fromEnv >= LONG_OUTPUT_THREAD_THRESHOLD_MIN) {
      const normalized = Math.trunc(fromEnv);
      if (normalized <= LONG_OUTPUT_THREAD_THRESHOLD_MAX) return normalized;
      if (normalized <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX) return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
      return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
    }
    return 1600;
  }

  private resolveStalePendingAlertMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1000) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1000) {
      return Math.trunc(fromEnv);
    }
    return 60000;
  }

  private resolveStalePendingAutoRecoverEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_CAPTURE_STALE_AUTO_RECOVER;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolvePromptEchoFilterEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;
    const raw = process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolvePromptEchoSuppressionMaxPolls(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1 && configured <= 20) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 20) {
      return Math.trunc(fromEnv);
    }
    return 4;
  }

  private resolveRedrawFallbackTailLines(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 10 && configured <= 400) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 10 && fromEnv <= 400) {
      return Math.trunc(fromEnv);
    }
    return 60;
  }

  private resolveProgressOutputVisibility(configured?: ProgressOutputVisibility): ProgressOutputVisibility {
    if (configured === 'off' || configured === 'thread' || configured === 'channel') {
      return configured;
    }
    const raw = process.env.AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT;
    if (!raw) return 'channel';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
      return normalized;
    }
    return 'channel';
  }

  private resolveCodexProgressHookMinIntervalMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 500 && configured <= 120_000) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_CODEX_PROGRESS_HOOK_MIN_INTERVAL_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 500 && fromEnv <= 120_000) {
      return Math.trunc(fromEnv);
    }
    return 5000;
  }

  private resolveCodexProgressHookMaxMessagesPerTurn(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 200) {
      return Math.trunc(fromEnv);
    }
    return 6;
  }

  private resolveFinalOnlyBufferMaxChars(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      const normalized = Math.trunc(configured);
      if (normalized >= FINAL_ONLY_BUFFER_MAX_CHARS_MIN && normalized <= FINAL_ONLY_BUFFER_MAX_CHARS_MAX) {
        return normalized;
      }
    }

    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS || '');
    if (Number.isFinite(fromEnv)) {
      const normalized = Math.trunc(fromEnv);
      if (normalized >= FINAL_ONLY_BUFFER_MAX_CHARS_MIN && normalized <= FINAL_ONLY_BUFFER_MAX_CHARS_MAX) {
        return normalized;
      }
    }

    return DEFAULT_FINAL_ONLY_BUFFER_MAX_CHARS;
  }

  private resolveEventHookCaptureFallbackStaleGraceMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 5 * 60 * 1000) {
      return Math.trunc(fromEnv);
    }
    return 10_000;
  }

  private resolveEventHookCaptureOutputEnabled(): boolean {
    const fromEnv = this.parseBoolean(process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT);
    if (fromEnv !== undefined) return fromEnv;
    return false;
  }

  private resolveIdleRefreshPolls(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 20) {
      return Math.trunc(fromEnv);
    }
    return 2;
  }

  private resolveIdleRefreshMaxPolls(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_MAX_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 120) {
      return Math.trunc(fromEnv);
    }
    return 8;
  }

  private resolveIdleRefreshBackoffMaxSteps(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_IDLE_REFRESH_BACKOFF_MAX_STEPS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 60) {
      return Math.trunc(fromEnv);
    }
    return 6;
  }

  private resolveIdleSkipThreshold(key: string): number {
    if (this.idleRefreshPolls <= 0) return 0;
    const backoff = this.idleSkipBackoffByInstance.get(key) || 0;
    const threshold = this.idleRefreshPolls + Math.max(0, backoff);
    return Math.max(this.idleRefreshPolls, Math.min(this.idleRefreshMaxPolls, threshold));
  }

  private bumpIdleSkipBackoff(key: string): void {
    if (this.idleRefreshBackoffMaxSteps <= 0) return;
    const current = this.idleSkipBackoffByInstance.get(key) || 0;
    const next = Math.min(this.idleRefreshBackoffMaxSteps, current + 1);
    if (next <= 0) {
      this.idleSkipBackoffByInstance.delete(key);
      return;
    }
    this.idleSkipBackoffByInstance.set(key, next);
  }

  private resolveDeadWorkerMissingPollThreshold(): number {
    const raw = process.env.AGENT_DISCORD_ORCHESTRATOR_DEAD_WORKER_MISSING_POLLS;
    if (raw && raw.trim().length > 0) {
      const fromEnv = Number(raw);
      if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 120) {
        return Math.trunc(fromEnv);
      }
    }
    return DEFAULT_DEAD_WORKER_MISSING_POLL_THRESHOLD;
  }

  private parseBoolean(raw: string | undefined): boolean | undefined {
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  }

  private parseIntInRange(raw: string | undefined, min: number, max: number): number | undefined {
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
    if (parsed < min || parsed > max) return undefined;
    return Math.trunc(parsed);
  }

  private resolveCodexEventProgressMode(): EventProgressMode | undefined {
    const direct = process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE;
    if (direct) {
      const normalized = direct.trim().toLowerCase();
      if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
        return normalized;
      }
    }
    const fallback = process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    if (!fallback) return undefined;
    const normalized = fallback.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
      return normalized;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'thread';
    if (['0', 'false', 'no'].includes(normalized)) return 'off';
    return undefined;
  }

  private resolveCodexEventProgressBlockStreaming(): boolean | undefined {
    const direct = this.parseBoolean(process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_STREAMING);
    if (direct !== undefined) return direct;
    return this.parseBoolean(process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING);
  }

  private resolveCodexEventProgressBlockWindowMs(): number | undefined {
    const direct = this.parseIntInRange(
      process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_WINDOW_MS,
      50,
      5000,
    );
    if (direct !== undefined) return direct;
    return this.parseIntInRange(process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS, 50, 5000);
  }

  private resolveCodexEventProgressBlockMaxChars(): number | undefined {
    const direct = this.parseIntInRange(
      process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_BLOCK_MAX_CHARS,
      200,
      8000,
    );
    if (direct !== undefined) return direct;
    return this.parseIntInRange(process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS, 200, 8000);
  }

  private formatDuration(ms: number): string {
    const sec = Math.max(1, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    return `${min}m`;
  }

  private markCaptureMutation(key: string, now: number): void {
    this.lastCaptureMutationAtByInstance.set(key, now);
    this.stalePendingAlertStageByInstance.delete(key);
    this.stalePendingAutoRecoveredBaselineByInstance.delete(key);
    this.finalOnlyQuietFlushPollsByInstance.delete(key);
  }

  private clearStalePendingAlertState(key: string): void {
    this.lastCaptureMutationAtByInstance.delete(key);
    this.stalePendingAlertStageByInstance.delete(key);
    this.stalePendingAutoRecoveredBaselineByInstance.delete(key);
  }

  private resolveNextStalePendingAlertStage(elapsedMs: number, currentStage: number): number {
    if (currentStage < 1 && elapsedMs >= this.stalePendingAlertMs) {
      return 1;
    }
    if (currentStage < 2 && elapsedMs >= this.stalePendingAlertMs * 2) {
      return 2;
    }
    return currentStage;
  }

  private async maybeSendStalePendingAlert(params: {
    key: string;
    pendingDepth: number;
    channelId?: string;
    projectName: string;
    agentType: string;
    instanceId: string;
    now: number;
  }): Promise<void> {
    if (params.pendingDepth <= 0) {
      this.clearStalePendingAlertState(params.key);
      return;
    }
    if (!params.channelId) return;

    const baseline = this.lastCaptureMutationAtByInstance.get(params.key);
    if (typeof baseline !== 'number') {
      this.lastCaptureMutationAtByInstance.set(params.key, params.now);
      return;
    }

    const elapsed = params.now - baseline;
    const currentStage = this.stalePendingAlertStageByInstance.get(params.key) ?? 0;
    const nextStage = this.resolveNextStalePendingAlertStage(elapsed, currentStage);
    if (nextStage === currentStage) return;

    const instanceLabel = params.instanceId || params.agentType;
    const durationLabel =
      nextStage === 1 ? this.formatDuration(this.stalePendingAlertMs) : this.formatDuration(this.stalePendingAlertMs * 2);
    const alertMessage =
      nextStage === 1
        ? `⚠️ No screen updates for ${durationLabel} on \`${params.projectName}/${instanceLabel}\`. It may be stuck. Try \`/retry\` or \`/health\`.`
        : `🚨 Still no screen updates for ${durationLabel} on \`${params.projectName}/${instanceLabel}\`. Try \`/esc\` then \`/retry\`, and check \`/health\`.`;
    await this.deps.messaging
      .sendToChannel(params.channelId, alertMessage)
      .catch(() => undefined);
    this.stalePendingAlertStageByInstance.set(params.key, nextStage);
    await this.maybeAutoRecoverStalePending({
      key: params.key,
      stage: nextStage,
      baselineMs: baseline,
      pendingDepth: params.pendingDepth,
      channelId: params.channelId,
      projectName: params.projectName,
      agentType: params.agentType,
      instanceId: params.instanceId,
    });
  }

  private async maybeAutoRecoverStalePending(params: {
    key: string;
    stage: number;
    baselineMs: number;
    pendingDepth: number;
    channelId?: string;
    projectName: string;
    agentType: string;
    instanceId: string;
  }): Promise<void> {
    if (!this.stalePendingAutoRecoverEnabled) return;
    if (params.stage < 2) return;
    if (params.pendingDepth <= 0) return;
    if (this.stalePendingAutoRecoveredBaselineByInstance.get(params.key) === params.baselineMs) return;

    const tracker = this.deps.pendingTracker as unknown as {
      markRetry?: (projectName: string, agentType: string, instanceId?: string, target?: 'head' | 'tail') => Promise<void>;
    };
    if (typeof tracker.markRetry !== 'function') return;

    await tracker.markRetry(params.projectName, params.agentType, params.instanceId).catch(() => undefined);
    this.stalePendingAutoRecoveredBaselineByInstance.set(params.key, params.baselineMs);
    this.quietPendingPollsByInstance.delete(params.key);
    this.completionCandidatesByInstance.delete(params.key);

    if (params.channelId) {
      await this.deps.messaging
        .sendToChannel(
          params.channelId,
          `🔁 Auto-recover triggered for \`${params.projectName}/${params.instanceId}\`: stale pending was marked as retry.`,
        )
        .catch(() => undefined);
    }
  }

  private shouldUseThreadedLongOutput(text: string): boolean {
    if (
      this.deps.messaging.platform !== 'discord' ||
      typeof this.deps.messaging.sendLongOutput !== 'function'
    ) {
      return false;
    }
    if (text.length >= this.longOutputThreadThreshold) {
      return true;
    }
    const nonEmptyLines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return text.length >= 600 && nonEmptyLines.length >= 12;
  }

  private async sendProgressChunk(
    channelId: string,
    payload: string,
    outputVisibility: ProgressOutputVisibility = this.progressOutputVisibility,
  ): Promise<boolean> {
    if (outputVisibility === 'off') {
      return false;
    }

    if (outputVisibility === 'thread') {
      if (typeof this.deps.messaging.sendToProgressThread === 'function') {
        await this.deps.messaging.sendToProgressThread(channelId, payload);
        return true;
      }
      await this.deps.messaging.sendToChannel(channelId, payload);
      return true;
    }

    await this.deps.messaging.sendToChannel(channelId, payload);
    return true;
  }

  private shouldSkipDuplicateProgressOutput(
    channelId: string,
    outputVisibility: ProgressOutputVisibility,
    text: string,
  ): boolean {
    if (this.progressDuplicateWindowMs <= 0) return false;
    const routeKey = `${channelId}:${outputVisibility}`;
    const now = Date.now();
    const previous = this.lastProgressOutputByRoute.get(routeKey);
    if (previous && previous.text === text && now - previous.atMs < this.progressDuplicateWindowMs) {
      return true;
    }
    this.lastProgressOutputByRoute.set(routeKey, { text, atMs: now });
    while (this.lastProgressOutputByRoute.size > 2000) {
      const oldest = this.lastProgressOutputByRoute.keys().next();
      if (oldest.done) break;
      this.lastProgressOutputByRoute.delete(oldest.value);
    }
    return false;
  }

  private resolveDiscordOutputMaxChunks(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_OUTPUT_MAX_CHUNKS || '');
    if (
      Number.isFinite(fromEnv) &&
      fromEnv >= DISCORD_OUTPUT_MAX_CHUNKS_MIN &&
      fromEnv <= DISCORD_OUTPUT_MAX_CHUNKS_MAX
    ) {
      return Math.trunc(fromEnv);
    }
    return DISCORD_OUTPUT_MAX_CHUNKS_DEFAULT;
  }

  private capDiscordOutputChunks(chunks: string[]): string[] {
    if (this.deps.messaging.platform !== 'discord') return chunks;
    const maxChunks = this.resolveDiscordOutputMaxChunks();
    if (chunks.length <= maxChunks) return chunks;
    if (maxChunks <= 1) {
      return ['⚠️ Output truncated to reduce Discord flood.'];
    }
    const keepCount = Math.max(1, maxChunks - 1);
    const omitted = Math.max(0, chunks.length - keepCount);
    return [
      ...chunks.slice(0, keepCount),
      `⚠️ Output truncated to reduce Discord flood: omitted ${omitted}/${chunks.length} chunks.`,
    ];
  }

  private async sendOutput(
    channelId: string,
    text: string,
    eventType: OutputEventType,
    outputVisibilityOverride?: ProgressOutputVisibility,
    agentType?: string,
  ): Promise<boolean> {
    const outputVisibility =
      outputVisibilityOverride || (eventType === 'progress' ? this.progressOutputVisibility : 'channel');
    if (outputVisibility === 'off') {
      return false;
    }

    const discordFormatted =
      this.deps.messaging.platform === 'discord'
        ? formatDiscordOutput(text)
        : { text, useCodeblock: false, language: 'text' };
    const content = discordFormatted.text;
    if (content.trim().length === 0) return false;
    if (
      eventType === 'progress' &&
      this.shouldSkipDuplicateProgressOutput(channelId, outputVisibility, content.trim())
    ) {
      return false;
    }
    if (
      eventType !== 'progress' &&
      agentType &&
      this.isCodexEventOutputAuthoritative(agentType)
    ) {
      return false;
    }

    const shouldUseLongOutputThread =
      this.shouldUseThreadedLongOutput(content) &&
      (eventType === 'final' || outputVisibility === 'channel') &&
      outputVisibility === 'channel';
    if (shouldUseLongOutputThread) {
      await this.deps.messaging.sendLongOutput!(channelId, content);
      return true;
    }

    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    const cappedChunks = this.capDiscordOutputChunks(
      split(content).filter((chunk) => chunk.trim().length > 0),
    );
    if (cappedChunks.length === 0) return false;
    let sentAnyChunk = false;
    for (const chunk of cappedChunks) {
      const payload =
        this.deps.messaging.platform === 'discord' &&
        discordFormatted.useCodeblock &&
        !chunk.startsWith('⚠️ Output truncated')
          ? wrapDiscordCodeblock(chunk, discordFormatted.language)
          : chunk;
      if (eventType === 'progress') {
        const sent = await this.sendProgressChunk(channelId, payload, outputVisibility);
        sentAnyChunk = sentAnyChunk || sent;
      } else {
        if (outputVisibility === 'thread' && typeof this.deps.messaging.sendToProgressThread === 'function') {
          await this.deps.messaging.sendToProgressThread(channelId, payload);
        } else {
          await this.deps.messaging.sendToChannel(channelId, payload);
        }
        sentAnyChunk = true;
      }
    }
    return sentAnyChunk;
  }

  private shouldBatchProgressDelta(agentType: string, pendingDepth: number): boolean {
    if (!this.progressBatchEnabled) return false;
    if (pendingDepth <= 0) return false;
    if (agentType === 'codex') return false;
    if (this.codexFinalOnlyModeEnabled && agentType === 'codex') return false;
    if (this.isCodexEventOutputAuthoritative(agentType)) return false;
    return true;
  }

  private appendProgressBatch(params: {
    key: string;
    text: string;
    channelId?: string;
    outputVisibility?: ProgressOutputVisibility;
    agentType: string;
  }): boolean {
    const trimmed = params.text.trim();
    if (trimmed.length === 0) return false;

    const existing = this.progressBatchByInstance.get(params.key);
    if (!existing) {
      this.progressBatchByInstance.set(params.key, {
        text: trimmed,
        channelId: params.channelId,
        outputVisibility: params.outputVisibility,
        agentType: params.agentType,
      });
      return trimmed.length >= this.progressBatchMaxChars;
    }

    const merged = this.mergeBufferedOutput(existing.text, trimmed, params.agentType);
    this.progressBatchByInstance.set(params.key, {
      text: merged,
      channelId: params.channelId || existing.channelId,
      outputVisibility: params.outputVisibility || existing.outputVisibility,
      agentType: params.agentType || existing.agentType,
    });
    return merged.length >= this.progressBatchMaxChars;
  }

  private async maybeFlushProgressBatch(params: {
    key: string;
    fallbackChannelId?: string;
    fallbackVisibility?: ProgressOutputVisibility;
    quietEvent?: boolean;
    force?: boolean;
  }): Promise<boolean> {
    const existing = this.progressBatchByInstance.get(params.key);
    if (!existing) return false;

    const normalized: ProgressBatchEntry = {
      ...existing,
      channelId: existing.channelId || params.fallbackChannelId,
      outputVisibility: existing.outputVisibility || params.fallbackVisibility,
    };
    const shouldFlush =
      params.force === true ||
      normalized.text.length >= this.progressBatchMaxChars ||
      params.quietEvent === true;

    if (!shouldFlush) {
      this.progressBatchByInstance.set(params.key, normalized);
      return false;
    }

    if (!normalized.channelId) {
      if (params.force) {
        this.progressBatchByInstance.delete(params.key);
      } else {
        this.progressBatchByInstance.set(params.key, normalized);
      }
      return false;
    }

    const sent = await this.sendOutput(
      normalized.channelId,
      normalized.text,
      'progress',
      normalized.outputVisibility,
      normalized.agentType,
    );
    if (sent || params.force) {
      this.progressBatchByInstance.delete(params.key);
    } else {
      this.progressBatchByInstance.set(params.key, normalized);
    }
    return sent;
  }

  private shouldBufferUntilCompletion(key: string, agentType: string, pendingDepth: number): boolean {
    return (
      this.codexFinalOnlyModeEnabled &&
      agentType === 'codex' &&
      (pendingDepth > 0 || this.bufferedOutputByInstance.has(key))
    );
  }

  private appendBufferedOutput(key: string, text: string, channelId?: string, agentType: string = ''): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (channelId && !this.bufferedOutputChannelByInstance.has(key)) {
      this.bufferedOutputChannelByInstance.set(key, channelId);
    }
    const previous = this.bufferedOutputByInstance.get(key);
    if (!previous) {
      const initial =
        this.codexFinalOnlyModeEnabled && agentType === 'codex'
          ? this.prepareCodexFinalOnlyOutput(trimmed)
          : trimmed;
      if (initial.trim().length === 0) return;
      this.bufferedOutputByInstance.set(key, this.trimBufferedOutput(initial));
      return;
    }
    const merged = this.mergeBufferedOutput(previous, trimmed, agentType);
    if (merged.trim().length === 0) return;
    this.bufferedOutputByInstance.set(key, merged);
  }

  private mergeBufferedOutput(previous: string, incoming: string, agentType: string): string {
    const overlap = this.longestSuffixPrefix(previous, incoming);
    const merged = overlap > 0 ? `${previous}${incoming.slice(overlap)}` : `${previous}\n${incoming}`;
    const normalized =
      this.codexFinalOnlyModeEnabled && agentType === 'codex'
        ? this.prepareCodexFinalOnlyOutput(merged)
        : merged;
    return this.trimBufferedOutput(normalized);
  }

  private trimBufferedOutput(text: string): string {
    const marker = '...[truncated by final-output buffer gate]\n';
    const raw = text.startsWith(marker) ? text.slice(marker.length) : text;
    if (raw.length <= this.finalOnlyBufferMaxChars) return raw;
    const tail = raw.slice(raw.length - this.finalOnlyBufferMaxChars).trimStart();
    return `${marker}${tail}`;
  }

  private prepareCodexFinalOnlyOutput(text: string): string {
    const sourceLines = text
      .split('\n')
      .map((line) => line.replace(/\r/g, '').trimEnd());
    const kept: string[] = [];
    let lastWasBlank = false;

    for (const raw of sourceLines) {
      const compact = raw.trim();
      if (compact.length === 0) {
        if (!lastWasBlank && kept.length > 0) {
          kept.push('');
        }
        lastWasBlank = true;
        continue;
      }

      if (this.isCodexIntermediaryBridgeLine(compact)) {
        continue;
      }

      kept.push(raw);
      lastWasBlank = false;
    }

    const compact = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (compact.length === 0) return '';

    const compactLines = compact.split('\n');
    let lastAssistantLine = -1;
    for (let i = compactLines.length - 1; i >= 0; i -= 1) {
      if (/^assistant\s*:/i.test(compactLines[i]!.trim())) {
        lastAssistantLine = i;
        break;
      }
    }
    if (lastAssistantLine >= 0) {
      return compactLines.slice(lastAssistantLine).join('\n').trim();
    }

    return compact;
  }

  private isCodexIntermediaryBridgeLine(line: string): boolean {
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;
    if (this.isCodexUiProgressNoiseLine(compact)) return true;
    if (this.isCodexUiStatusNoiseLine(compact)) return true;
    if (/^›(?:\s.*)?$/.test(compact)) return true;
    if (/^[-─]{20,}$/.test(compact)) return true;
    if (/^[│└├]/.test(compact)) return true;
    if (/^would you like to run the following command\?/i.test(compact)) return true;
    if (/^press enter to confirm or esc to cancel$/i.test(compact)) return true;
    if (/^\d+\.\s+(yes|no)\b/i.test(compact)) return true;
    if (/^token usage:/i.test(compact)) return true;
    if (/^to continue this session, run codex resume\b/i.test(compact)) return true;
    if (/^tip:\s/i.test(compact)) return true;
    if (/^⚠\s*mcp /i.test(compact)) return true;
    if (/^⚠\s*`?collab`?\s+is deprecated/i.test(compact)) return true;
    if (
      /^•\s*(ran|explored|read|search|find|list|open(?:ed)?|click(?:ed)?|screenshot|apply|applied|edit(?:ed|ing)?|update(?:d|ing)?|create(?:d|ing)?|delete(?:d|ing)?|move(?:d|ing)?|analy(?:ze|zing)|check(?:ing)?|verify|verifying|inspect(?:ing)?|debug(?:ging)?|run(?:ning)?|execute|executing)\b/i.test(
        compact,
      )
    ) {
      return true;
    }
    return false;
  }

  private isLikelyCodexReadyForInput(captureSnapshot: string): boolean {
    if (!captureSnapshot || captureSnapshot.trim().length === 0) return false;

    const lines = captureSnapshot
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return false;

    const tail = lines.slice(-24);
    if (tail.some((line) => /^esc to interrupt\b/i.test(line))) return false;

    const promptPattern = /^›(?:\s.*)?$/;
    const bottomSlice = tail.slice(-4);
    const promptNearBottom = bottomSlice.some((line) => promptPattern.test(line));
    if (!promptNearBottom) return false;

    const lastLine = tail[tail.length - 1] || '';
    if (promptPattern.test(lastLine)) return true;

    // In Codex full-screen UI, footer often sits below the input prompt.
    const footerNearBottom = bottomSlice.some((line) => this.isCodexUiStatusNoiseLine(line));
    return footerNearBottom;
  }

  private hasCodexWorkingMarker(captureSnapshot: string): boolean {
    const lines = captureSnapshot
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return false;

    const tail = lines.slice(-24);
    return tail.some((line) => /\besc to interrupt\b/.test(line));
  }

  private async safeEmitCodexFinalEvent(params: {
    key: string;
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text: string;
  }): Promise<boolean> {
    const normalizedTurnId = params.turnId?.trim();
    if (normalizedTurnId && this.codexFinalHookTurnByInstance.get(params.key) === normalizedTurnId) {
      // Event-only mode: one terminal final emit per turn from capture path.
      return true;
    }
    const hookClient = this.deps.eventHookClient;
    if (!hookClient?.enabled) return false;
    try {
      const emitted = await hookClient.emitCodexFinal({
        projectName: params.projectName,
        instanceId: params.instanceId,
        turnId: params.turnId,
        channelId: params.channelId,
        text: params.text,
      });
      if (emitted && normalizedTurnId) {
        this.codexFinalHookTurnByInstance.set(params.key, normalizedTurnId);
      }
      return emitted;
    } catch (error) {
      console.warn(
        `Codex final hook emit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private resolveSupervisorFinalFormatPolicy(params: {
    projectName: string;
    instanceId: string;
    agentType: string;
  }): 
    | {
        normalizedProject: ReturnType<typeof normalizeProjectState>;
        tmuxWindow: string;
        maxRetries: number;
      }
    | undefined {
    if (params.agentType !== 'codex') return undefined;
    const stateManager = this.deps.stateManager as unknown as {
      getProject?: (projectName: string) => ProjectState | undefined;
      listProjects?: () => ProjectState[];
    };
    const rawProject =
      (typeof stateManager.getProject === 'function'
        ? stateManager.getProject(params.projectName)
        : undefined) ||
      (typeof stateManager.listProjects === 'function'
        ? stateManager
            .listProjects()
            .find((entry) => (entry as { projectName?: string })?.projectName === params.projectName)
        : undefined);
    if (!rawProject) return undefined;

    const project = normalizeProjectState(rawProject);
    const orchestrator = project.orchestrator;
    if (!orchestrator?.enabled) return undefined;
    if (!orchestrator.supervisorInstanceId || orchestrator.supervisorInstanceId !== params.instanceId) {
      return undefined;
    }

    if (orchestrator.supervisorFinalFormat?.enforce !== true) return undefined;
    const maxRetriesRaw = orchestrator.supervisorFinalFormat?.maxRetries;
    const maxRetries =
      typeof maxRetriesRaw === 'number' && Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0
        ? Math.min(10, Math.max(0, Math.trunc(maxRetriesRaw)))
        : 2;
    const instance = getProjectInstance(project, params.instanceId);
    if (!instance) return undefined;
    const tmuxWindow = instance.tmuxWindow || instance.instanceId;
    if (!tmuxWindow) return undefined;
    return {
      normalizedProject: project,
      tmuxWindow,
      maxRetries,
    };
  }

  private isSupervisorFinalFormatCompliant(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    const strictRaw = (process.env.AGENT_DISCORD_SUPERVISOR_FINAL_FORMAT_STRICT || '').trim().toLowerCase();
    const strict = strictRaw.length === 0 ? true : !['0', 'false', 'no', 'off'].includes(strictRaw);
    const evidenceRaw = (process.env.AGENT_DISCORD_SUPERVISOR_FINAL_REQUIRE_EVIDENCE || '').trim().toLowerCase();
    const requireEvidence = evidenceRaw.length === 0 ? true : !['0', 'false', 'no', 'off'].includes(evidenceRaw);

    const numberedNeed =
      /^\s*1[\.\)]\s*(need your check|manual check|확인 필요|체크 필요|need check|체크|확인)\b/im.test(trimmed);
    const numberedChanges =
      /^\s*2[\.\)]\s*(changes?|deltas?|변경|수정)\b/im.test(trimmed);
    const numberedVerification =
      /^\s*3[\.\)]\s*(verification|tests?|검증|테스트)\b/im.test(trimmed);
    if (numberedNeed && numberedChanges && numberedVerification) {
      return requireEvidence ? this.hasSupervisorFinalEvidence(trimmed) : true;
    }

    const headingNeed =
      /(?:^|\n)\s*(?:\*\*)?(need your check|manual check|확인 필요|체크 필요)(?:\*\*)?\s*:?/im.test(trimmed);
    const headingChanges =
      /(?:^|\n)\s*(?:\*\*)?(changes?|deltas?|변경|수정)(?:\*\*)?\s*:?/im.test(trimmed);
    const headingVerification =
      /(?:^|\n)\s*(?:\*\*)?(verification|tests?|검증|테스트)(?:\*\*)?\s*:?/im.test(trimmed);
    if (headingNeed && headingChanges && headingVerification) {
      return requireEvidence ? this.hasSupervisorFinalEvidence(trimmed) : true;
    }

    if (!strict) {
      if (trimmed.length <= 320) return true;
      const hasNeedKeyword = /\bneed your check\b/i.test(trimmed) || /(체크|확인)\b/.test(trimmed);
      const hasChangeKeyword = /\bchanges?\b/i.test(trimmed) || /(변경|수정)\b/.test(trimmed);
      const hasVerificationKeyword = /\bverification\b/i.test(trimmed) || /(검증|테스트)\b/.test(trimmed);
      const basic = hasNeedKeyword && hasChangeKeyword && hasVerificationKeyword;
      if (!basic) return false;
      return requireEvidence ? this.hasSupervisorFinalEvidence(trimmed) : true;
    }
    return false;
  }

  private hasSupervisorFinalEvidence(text: string): boolean {
    return this.hasSupervisorChangeEvidence(text) && this.hasSupervisorVerificationEvidence(text);
  }

  private hasSupervisorChangeEvidence(text: string): boolean {
    const normalized = text.trim();
    if (normalized.length === 0) return false;
    const noChange =
      /\bno\s+changes?\b/i.test(normalized) ||
      /\bchanges?\s*:\s*none\b/i.test(normalized) ||
      /\bnone\b/i.test(normalized) ||
      /(변경|수정)\s*없음/.test(normalized) ||
      /\b없음\b/.test(normalized);
    if (noChange) return true;

    const filePathEvidence =
      /(?:^|\n)\s*(?:[-*]|\d+[\.\)])?\s*`?(\/[A-Za-z0-9._\-/]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?)`?(?::\d+(?::\d+)?)?\s*$/m
        .test(normalized);
    return filePathEvidence;
  }

  private hasSupervisorVerificationEvidence(text: string): boolean {
    const normalized = text.trim();
    if (normalized.length === 0) return false;

    const commandEvidence =
      /`(?:bun|npm|pnpm|yarn|vitest|jest|cargo|go|python|pytest|tsc|node|git|rg|sed|bash|sh)\b[^`\n]*`/i.test(
        normalized,
      ) ||
      /(?:^|\n)\s*(?:[-*]|\d+[\.\)])\s*(?:bun|npm|pnpm|yarn|vitest|jest|cargo|go|python|pytest|tsc|node|git|rg|sed|bash|sh)\b[^\n]*/im.test(
        normalized,
      );
    if (!commandEvidence) return false;

    const resultEvidence =
      /\b(pass|passed|fail|failed|success|succeeded|error|errored|skipped|not run)\b/i.test(normalized) ||
      /(성공|실패|통과|오류|미실행|건너뜀)/.test(normalized);
    return resultEvidence;
  }

  private buildSupervisorFinalFormatRetryPrompt(): string {
    return [
      '[mudcode supervisor-final-format]',
      'Rewrite the previous final response in this exact concise format:',
      '1) Need your check (manual actions only, or "none")',
      '2) Changes (file/behavior deltas only; include at least one file path or "none")',
      '3) Verification (commands run + pass/fail; include command text and result)',
      'Do not include process logs or internal analysis.',
      '[/mudcode supervisor-final-format]',
    ].join('\n');
  }

  private buildSupervisorFinalFormatRetryTurnId(params: {
    projectName: string;
    instanceId: string;
  }): string {
    const now = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `fmt-${params.projectName}-${params.instanceId}-${now}-${rand}`;
  }

  private async safeTrackSupervisorFormatRetryPending(params: {
    projectName: string;
    agentType: string;
    instanceId: string;
    channelId: string;
    turnId: string;
    prompt: string;
    deferDispatchingToEvents?: boolean;
  }): Promise<void> {
    const tracker = this.deps.pendingTracker as unknown as {
      markPending?: (
        projectName: string,
        agentType: string,
        channelId: string,
        messageId: string,
        instanceId?: string,
        prompt?: string,
      ) => Promise<void>;
      markRouteResolved?: (
        projectName: string,
        agentType: string,
        instanceId?: string,
        hint?: 'reply' | 'thread' | 'memory',
      ) => Promise<void>;
      markDispatching?: (projectName: string, agentType: string, instanceId?: string) => Promise<void>;
    };
    if (typeof tracker.markPending === 'function') {
      await tracker.markPending(
        params.projectName,
        params.agentType,
        params.channelId,
        params.turnId,
        params.instanceId,
        params.prompt,
      );
    }
    if (typeof tracker.markRouteResolved === 'function') {
      await tracker.markRouteResolved(params.projectName, params.agentType, params.instanceId, 'memory');
    }
    if (!params.deferDispatchingToEvents && typeof tracker.markDispatching === 'function') {
      await tracker.markDispatching(params.projectName, params.agentType, params.instanceId);
    }
  }

  private async requestSupervisorFinalFormatRetry(params: {
    key: string;
    projectName: string;
    instanceId: string;
    channelId: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    tmuxWindow: string;
    nextAttempt: number;
    maxRetries: number;
  }): Promise<string | undefined> {
    const prompt = this.buildSupervisorFinalFormatRetryPrompt();
    const turnId = this.buildSupervisorFinalFormatRetryTurnId({
      projectName: params.projectName,
      instanceId: params.instanceId,
    });
    const instance = getProjectInstance(params.normalizedProject, params.instanceId);
    const deferDispatchingToEvents = Boolean(
      this.deps.eventHookClient?.enabled && instance && instance.agentType === 'codex' && instance.eventHook !== false,
    );

    try {
      await this.safeTrackSupervisorFormatRetryPending({
        projectName: params.projectName,
        agentType: 'codex',
        instanceId: params.instanceId,
        channelId: params.channelId,
        turnId,
        prompt,
        deferDispatchingToEvents,
      });
      this.lastPendingTurnIdByInstance.set(params.key, turnId);
      this.progressHookInFlightByInstance.delete(params.key);
      this.progressHookHeartbeatByInstance.delete(params.key);
      this.deps.tmux.typeKeysToWindow(
        params.normalizedProject.tmuxSession,
        params.tmuxWindow,
        prompt,
        'codex',
      );
      this.deps.tmux.sendEnterToWindow(params.normalizedProject.tmuxSession, params.tmuxWindow, 'codex');
      await this.deps.messaging.sendToChannel(
        params.channelId,
        `🔁 Supervisor final-format retry ${params.nextAttempt}/${params.maxRetries} requested.`,
      );
      if (this.deps.eventHookClient?.enabled) {
        this.deps.eventHookClient
          .emitCodexStart({
            projectName: params.projectName,
            instanceId: params.instanceId,
            turnId,
            channelId: params.channelId,
          })
          .catch(() => undefined);
      }
      return turnId;
    } catch (error) {
      console.warn(
        `Supervisor final-format retry request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private resolveCodexProgressHookEventConfig(params: {
    projectName: string;
    instanceId: string;
    channelId?: string;
  }): {
    mode?: EventProgressMode;
    blockStreamingEnabled?: boolean;
    blockWindowMs?: number;
    blockMaxChars?: number;
  } {
    let mode: EventProgressMode | undefined = this.codexEventProgressMode;
    let blockStreamingEnabled = this.codexEventProgressBlockStreaming;
    let blockWindowMs = this.codexEventProgressBlockWindowMs;
    let blockMaxChars = this.codexEventProgressBlockMaxChars;

    const stateManager = this.deps.stateManager as unknown as {
      getProject?: (projectName: string) => ProjectState | undefined;
      listProjects?: () => ProjectState[];
    };
    const rawProject =
      (typeof stateManager.getProject === 'function'
        ? stateManager.getProject(params.projectName)
        : undefined) ||
      (typeof stateManager.listProjects === 'function'
        ? stateManager
            .listProjects()
            .find((entry) => (entry as { projectName?: string })?.projectName === params.projectName)
        : undefined);
    if (!rawProject) {
      return {
        mode,
        blockStreamingEnabled,
        blockWindowMs,
        blockMaxChars,
      };
    }
    if (!rawProject.orchestrator?.progressPolicy) {
      return {
        mode,
        blockStreamingEnabled,
        blockWindowMs,
        blockMaxChars,
      };
    }
    const project = rawProject as ReturnType<typeof normalizeProjectState>;
    const directive = resolveProgressPolicyDirective({
      project,
      agentType: 'codex',
      instanceId: params.instanceId,
      channelId: params.channelId,
    });

    mode = directive.mode ?? mode;
    blockStreamingEnabled = directive.blockStreamingEnabled ?? blockStreamingEnabled;
    blockWindowMs = directive.blockWindowMs ?? blockWindowMs;
    blockMaxChars = directive.blockMaxChars ?? blockMaxChars;

    return {
      mode,
      blockStreamingEnabled,
      blockWindowMs,
      blockMaxChars,
    };
  }

  private maybeEmitCodexProgressEvent(params: {
    projectName: string;
    instanceId: string;
    key: string;
    pendingDepth: number;
    codexWorkingHint: boolean;
    channelId?: string;
    text?: string;
  }): void {
    const hookClient = this.deps.eventHookClient;
    if (!hookClient?.enabled) return;
    if (params.pendingDepth <= 0 && !params.codexWorkingHint) return;
    if (this.progressHookInFlightByInstance.has(params.key)) return;

    const turnId = this.lastPendingTurnIdByInstance.get(params.key);
    const now = Date.now();
    const previous = this.progressHookHeartbeatByInstance.get(params.key);
    if (
      previous &&
      previous.turnId === turnId &&
      now - previous.atMs < this.codexProgressHookMinIntervalMs
    ) {
      return;
    }
    if (this.shouldSuppressCodexProgressBurst({ key: params.key, turnId })) {
      return;
    }

    const progressConfig = this.resolveCodexProgressHookEventConfig({
      projectName: params.projectName,
      instanceId: params.instanceId,
      channelId: params.channelId,
    });

    this.progressHookInFlightByInstance.add(params.key);
    void hookClient.emitCodexProgress({
        projectName: params.projectName,
        instanceId: params.instanceId,
        turnId,
        channelId: params.channelId,
        text: params.text,
        progressMode: progressConfig.mode,
        progressBlockStreaming: progressConfig.blockStreamingEnabled,
        progressBlockWindowMs: progressConfig.blockWindowMs,
        progressBlockMaxChars: progressConfig.blockMaxChars,
      })
      .then((ok) => {
        if (ok) {
          this.progressHookHeartbeatByInstance.set(params.key, { atMs: Date.now(), turnId });
        }
      })
      .catch((error) => {
        console.warn(
          `Codex progress hook emit failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.progressHookInFlightByInstance.delete(params.key);
      });
  }

  private async flushBufferedOutput(params: {
    key: string;
    channelId?: string;
    agentType: string;
    projectName: string;
    instanceId: string;
    outputVisibility?: ProgressOutputVisibility;
  }): Promise<boolean> {
    const { key, channelId, agentType, projectName, instanceId } = params;
    const buffered = this.bufferedOutputByInstance.get(key);
    if (!buffered || buffered.trim().length === 0) {
      this.bufferedOutputByInstance.delete(key);
      this.bufferedOutputChannelByInstance.delete(key);
      this.supervisorFinalFormatRetryStateByInstance.delete(key);
      this.progressHookHeartbeatByInstance.delete(key);
      this.progressHookInFlightByInstance.delete(key);
      this.progressHookBurstByInstance.delete(key);
      return false;
    }
    const targetChannelId = this.bufferedOutputChannelByInstance.get(key) || channelId;
    if (!targetChannelId) return false;

    const prepared =
      this.codexFinalOnlyModeEnabled && agentType === 'codex'
        ? this.prepareCodexFinalOnlyOutput(buffered)
        : buffered.trim();
    if (this.codexFinalOnlyModeEnabled && agentType === 'codex' && prepared.trim().length === 0) {
      this.bufferedOutputByInstance.delete(key);
      this.bufferedOutputChannelByInstance.delete(key);
      this.supervisorFinalFormatRetryStateByInstance.delete(key);
      this.progressHookHeartbeatByInstance.delete(key);
      this.progressHookInFlightByInstance.delete(key);
      this.progressHookBurstByInstance.delete(key);
      return true;
    }
    const output = prepared.trim().length > 0 ? prepared : buffered.trim();
    if (agentType === 'codex') {
      const policy = this.resolveSupervisorFinalFormatPolicy({
        projectName,
        instanceId,
        agentType,
      });
      if (policy) {
        const currentTurnId = this.lastPendingTurnIdByInstance.get(key);
        const state = this.supervisorFinalFormatRetryStateByInstance.get(key);
        const retryCount =
          state && currentTurnId && state.lastTurnId && currentTurnId === state.lastTurnId ? state.count : 0;
        const compliant = this.isSupervisorFinalFormatCompliant(output);

        if (!compliant && retryCount < policy.maxRetries) {
          const nextAttempt = retryCount + 1;
          const retryTurnId = await this.requestSupervisorFinalFormatRetry({
            key,
            projectName,
            instanceId,
            channelId: targetChannelId,
            normalizedProject: policy.normalizedProject,
            tmuxWindow: policy.tmuxWindow,
            nextAttempt,
            maxRetries: policy.maxRetries,
          });
          if (retryTurnId) {
            this.supervisorFinalFormatRetryStateByInstance.set(key, {
              count: nextAttempt,
              lastTurnId: retryTurnId,
            });
            this.bufferedOutputByInstance.delete(key);
            this.finalOnlyQuietFlushPollsByInstance.delete(key);
            return false;
          }
        }
        if (!compliant && retryCount >= policy.maxRetries) {
          await this.deps.messaging.sendToChannel(
            targetChannelId,
            `⚠️ Supervisor final-format retries exhausted (${policy.maxRetries}); sending latest output as-is.`,
          );
        }
      }
    }
    if (agentType === 'codex') {
      const turnId = this.lastPendingTurnIdByInstance.get(key);
      if (this.isCodexEventOnlyActive(agentType) && (!turnId || turnId.trim().length === 0)) {
        // Event-driven final delivery is turn-scoped; avoid emitting no-turn finals
        // that can bypass lifecycle dedupe and fan out duplicates.
        return false;
      }
      const emitted = await this.safeEmitCodexFinalEvent({
        key,
        projectName,
        instanceId,
        turnId,
        channelId: targetChannelId,
        text: output,
      });
      if (emitted) {
        this.bufferedOutputByInstance.delete(key);
        this.bufferedOutputChannelByInstance.delete(key);
        this.supervisorFinalFormatRetryStateByInstance.delete(key);
        this.progressHookHeartbeatByInstance.delete(key);
        this.progressHookInFlightByInstance.delete(key);
        this.progressHookBurstByInstance.delete(key);
        return true;
      }
    }
    if (params.outputVisibility === 'off') {
      this.bufferedOutputByInstance.delete(key);
      this.bufferedOutputChannelByInstance.delete(key);
      this.supervisorFinalFormatRetryStateByInstance.delete(key);
      this.progressHookHeartbeatByInstance.delete(key);
      this.progressHookInFlightByInstance.delete(key);
      this.progressHookBurstByInstance.delete(key);
      return true;
    }
    if (agentType === 'codex' && this.deps.eventHookClient?.enabled) {
      // Codex output delivery is event-driven; never fall back to direct capture flush.
      return false;
    }
    const sent = await this.sendOutput(
      targetChannelId,
      output,
      'final',
      params.outputVisibility,
      agentType,
    );
    if (!sent) return false;

    this.bufferedOutputByInstance.delete(key);
    this.bufferedOutputChannelByInstance.delete(key);
    this.supervisorFinalFormatRetryStateByInstance.delete(key);
    this.progressHookHeartbeatByInstance.delete(key);
    this.progressHookInFlightByInstance.delete(key);
    this.progressHookBurstByInstance.delete(key);
    return sent;
  }

  private shouldSuppressCodexProgressBurst(params: { key: string; turnId?: string }): boolean {
    const limit = this.codexProgressHookMaxMessagesPerTurn;
    if (limit < 1) return false;

    const normalizedTurnId = params.turnId?.trim();
    if (!normalizedTurnId) return false;

    const now = Date.now();
    const previous = this.progressHookBurstByInstance.get(params.key);
    const current: ProgressHookBurstState =
      previous && previous.turnId === normalizedTurnId
        ? previous
        : { turnId: normalizedTurnId, emittedCount: 0, suppressedCount: 0, updatedAtMs: now };

    current.updatedAtMs = now;
    if (current.emittedCount >= limit) {
      current.suppressedCount += 1;
      this.progressHookBurstByInstance.set(params.key, current);
      return true;
    }
    current.emittedCount += 1;
    this.progressHookBurstByInstance.set(params.key, current);
    return false;
  }

  private pruneProgressHookBurstStates(activeCaptureKeys: Set<string>): void {
    if (this.progressHookBurstByInstance.size === 0) return;
    for (const key of this.progressHookBurstByInstance.keys()) {
      if (!activeCaptureKeys.has(key)) {
        this.progressHookBurstByInstance.delete(key);
      }
    }
  }

  private resolvePendingRouteSnapshot(
    projectName: string,
    agentType: string,
    instanceId?: string,
  ): PendingRouteSnapshot {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getPendingRouteSnapshot?: (projectName: string, agentType: string, instanceId?: string) => PendingRouteSnapshot;
      getPendingChannel?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
      getPendingMessageId?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
      getPendingPromptTails?: (projectName: string, agentType: string, instanceId?: string) => string[];
      getPendingPromptTail?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
    };

    if (typeof pendingTracker.getPendingRouteSnapshot === 'function') {
      const snapshot = pendingTracker.getPendingRouteSnapshot(projectName, agentType, instanceId);
      return {
        channelId: snapshot.channelId,
        pendingDepth: Math.max(0, Math.trunc(snapshot.pendingDepth || 0)),
        messageId: snapshot.messageId,
        promptTails: (snapshot.promptTails || []).filter((tail) => tail.trim().length > 0),
      };
    }

    const channelId =
      typeof pendingTracker.getPendingChannel === 'function'
        ? pendingTracker.getPendingChannel(projectName, agentType, instanceId)
        : undefined;
    const pendingDepth =
      typeof pendingTracker.getPendingDepth === 'function'
        ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
        : channelId
          ? 1
          : 0;
    const messageId =
      typeof pendingTracker.getPendingMessageId === 'function'
        ? pendingTracker.getPendingMessageId(projectName, agentType, instanceId)
        : undefined;
    const promptTails =
      typeof pendingTracker.getPendingPromptTails === 'function'
        ? pendingTracker.getPendingPromptTails(projectName, agentType, instanceId)
        : typeof pendingTracker.getPendingPromptTail === 'function'
          ? (() => {
              const tail = pendingTracker.getPendingPromptTail(projectName, agentType, instanceId);
              return tail ? [tail] : [];
            })()
          : [];

    return {
      channelId,
      pendingDepth: Math.max(0, Math.trunc(pendingDepth || 0)),
      messageId,
      promptTails: promptTails.filter((tail) => tail.trim().length > 0),
    };
  }

  private shouldCaptureEventHookInstance(
    projectName: string,
    instanceId: string,
    agentType: string,
    key: string,
    pendingActive: boolean,
  ): boolean {
    if (typeof this.deps.eventLifecycleStaleChecker !== 'function') {
      this.eventHookFallbackActiveByInstance.delete(key);
      this.eventHookStaleSinceByInstance.delete(key);
      return false;
    }
    const now = Date.now();
    const stale = this.deps.eventLifecycleStaleChecker(projectName, instanceId, agentType);
    const wasActive = this.eventHookFallbackActiveByInstance.has(key);
    if (!pendingActive && !wasActive) {
      return false;
    }
    if (stale) {
      if (!this.eventHookStaleSinceByInstance.has(key)) {
        this.eventHookStaleSinceByInstance.set(key, now);
      }
    } else {
      this.eventHookStaleSinceByInstance.delete(key);
    }

    const staleSince = this.eventHookStaleSinceByInstance.get(key) ?? now;
    const staleAgeMs = Math.max(0, now - staleSince);
    const staleMatured = staleAgeMs >= this.eventHookCaptureFallbackStaleGraceMs;
    if (stale && !wasActive) {
      if (!staleMatured) {
        return false;
      }
      this.eventHookFallbackActiveByInstance.add(key);
      console.warn(
        `⚠️ Event-hook lifecycle stale; enabling capture fallback for ${projectName}/${instanceId} after ${this.formatDuration(staleAgeMs)} grace`,
      );
      return true;
    }
    if (!stale && wasActive) {
      this.eventHookFallbackActiveByInstance.delete(key);
      this.eventHookStaleSinceByInstance.delete(key);
      console.log(`✅ Event-hook lifecycle recovered; disabling capture fallback for ${projectName}/${instanceId}`);
      return false;
    }
    return stale && (pendingActive || wasActive);
  }

  private hasActiveCaptureState(key: string): boolean {
    return (
      this.bufferedOutputByInstance.has(key) ||
      this.bufferedOutputChannelByInstance.has(key) ||
      this.completionCandidatesByInstance.has(key) ||
      this.quietPendingPollsByInstance.has(key) ||
      this.finalOnlyQuietFlushPollsByInstance.has(key) ||
      this.promptEchoSuppressedPollsByInstance.has(key) ||
      this.lastPendingTurnIdByInstance.has(key) ||
      this.progressHookHeartbeatByInstance.has(key) ||
      this.progressHookInFlightByInstance.has(key) ||
      this.progressBatchByInstance.has(key)
    );
  }

  private shouldApplyIdleSkip(agentType: string, outputVisibility?: ProgressOutputVisibility): boolean {
    if (agentType === 'codex') return true;
    return outputVisibility === 'off';
  }

  private clearCaptureStateForKey(key: string): void {
    this.snapshotsByInstance.delete(key);
    this.rawCaptureSnapshotByInstance.delete(key);
    this.lastCaptureMutationAtByInstance.delete(key);
    this.stalePendingAlertStageByInstance.delete(key);
    this.stalePendingAutoRecoveredBaselineByInstance.delete(key);
    this.completionCandidatesByInstance.delete(key);
    this.quietPendingPollsByInstance.delete(key);
    this.finalOnlyQuietFlushPollsByInstance.delete(key);
    this.promptEchoSuppressedPollsByInstance.delete(key);
    this.bufferedOutputByInstance.delete(key);
    this.bufferedOutputChannelByInstance.delete(key);
    this.lastPendingTurnIdByInstance.delete(key);
    this.supervisorFinalFormatRetryStateByInstance.delete(key);
    this.progressHookHeartbeatByInstance.delete(key);
    this.progressHookInFlightByInstance.delete(key);
    this.progressHookBurstByInstance.delete(key);
    this.codexFinalHookTurnByInstance.delete(key);
    this.eventHookFallbackActiveByInstance.delete(key);
    this.eventHookStaleSinceByInstance.delete(key);
    this.idleSkipPollsByInstance.delete(key);
    this.idleSkipBackoffByInstance.delete(key);
    this.progressBatchByInstance.delete(key);
    this.missingWorkerWindowPollsByInstance.delete(key);
  }

  private pruneMissingWorkerWindowPolls(activeInstanceKeys: Set<string>): void {
    if (this.missingWorkerWindowPollsByInstance.size === 0) return;
    for (const key of this.missingWorkerWindowPollsByInstance.keys()) {
      if (activeInstanceKeys.has(key)) continue;
      this.missingWorkerWindowPollsByInstance.delete(key);
    }
  }

  private async maybeReconcileDeadWorkerInstance(params: {
    project: ProjectState;
    instanceId: string;
    agentType: string;
    key: string;
    targetWindow: string;
  }): Promise<boolean> {
    if (this.deadWorkerMissingPollThreshold <= 0) return false;
    if (typeof this.deps.tmux.windowExists !== 'function') return false;
    const orchestrator = params.project.orchestrator;
    if (!orchestrator?.enabled) {
      this.missingWorkerWindowPollsByInstance.delete(params.key);
      return false;
    }
    if (orchestrator.supervisorInstanceId === params.instanceId) {
      this.missingWorkerWindowPollsByInstance.delete(params.key);
      return false;
    }
    if (!(orchestrator.workerInstanceIds || []).includes(params.instanceId)) {
      this.missingWorkerWindowPollsByInstance.delete(params.key);
      return false;
    }
    const windowExists = this.deps.tmux.windowExists(params.project.tmuxSession, params.targetWindow);
    if (windowExists) {
      this.missingWorkerWindowPollsByInstance.delete(params.key);
      return false;
    }

    const nextCount = (this.missingWorkerWindowPollsByInstance.get(params.key) || 0) + 1;
    this.missingWorkerWindowPollsByInstance.set(params.key, nextCount);
    if (nextCount < this.deadWorkerMissingPollThreshold) {
      return true;
    }

    this.missingWorkerWindowPollsByInstance.delete(params.key);
    const latestRaw = this.deps.stateManager.getProject(params.project.projectName);
    if (!latestRaw) return true;
    const latest = normalizeProjectState(latestRaw);
    const latestOrchestrator = latest.orchestrator;
    if (!latestOrchestrator?.enabled) return true;
    if (!(latestOrchestrator.workerInstanceIds || []).includes(params.instanceId)) return true;

    const worker = getProjectInstance(latest, params.instanceId);
    if (!worker) return true;
    const latestTargetWindow = worker.tmuxWindow || worker.instanceId;
    if (latestTargetWindow && this.deps.tmux.windowExists(latest.tmuxSession, latestTargetWindow)) {
      return true;
    }

    const nextInstances = { ...(latest.instances || {}) };
    delete nextInstances[params.instanceId];
    const nextWorkerIds = (latestOrchestrator.workerInstanceIds || []).filter((id) => id !== params.instanceId);
    this.deps.stateManager.setProject(
      normalizeProjectState({
        ...latest,
        instances: nextInstances,
        orchestrator: {
          ...latestOrchestrator,
          enabled: true,
          workerInstanceIds: nextWorkerIds,
        },
        lastActive: new Date(),
      }),
    );

    this.deps.pendingTracker.clearPendingForInstance(params.project.projectName, params.agentType, params.instanceId);
    this.clearCaptureStateForKey(params.key);

    const supervisorChannelId = latestOrchestrator.supervisorInstanceId
      ? getProjectInstance(latest, latestOrchestrator.supervisorInstanceId)?.channelId
      : undefined;
    const notifyChannel = supervisorChannelId || worker.channelId;
    if (notifyChannel) {
      await this.deps.messaging
        .sendToChannel(
          notifyChannel,
          `🧹 Removed stale worker \`${params.instanceId}\` from orchestrator state (tmux window missing for ${this.deadWorkerMissingPollThreshold} polls).`,
        )
        .catch(() => undefined);
    }
    return true;
  }

  private async deliverDelta(params: {
    projectName: string;
    instanceId: string;
    key: string;
    agentType: string;
    pendingDepth: number;
    codexWorkingHint?: boolean;
    eventHookCapture: boolean;
    channelId?: string;
    outputVisibility?: ProgressOutputVisibility;
    deltaText: string;
  }): Promise<DeltaDeliveryResult> {
    const trimmed = params.deltaText.trim();
    if (trimmed.length === 0) return { observedOutput: false, emittedOutput: false };
    if (params.agentType === 'codex') {
      this.deps.ioTracker?.recordOutputDelta({
        projectName: params.projectName,
        instanceId: params.instanceId,
        channelId: params.channelId,
        deltaText: trimmed,
      });
      this.maybeEmitCodexProgressEvent({
        projectName: params.projectName,
        instanceId: params.instanceId,
        key: params.key,
        pendingDepth: params.pendingDepth,
        codexWorkingHint: params.codexWorkingHint === true,
        channelId: params.channelId,
        text: trimmed,
      });
    }

    if (this.codexFinalOnlyModeEnabled && params.agentType === 'codex') {
      // Any newly observed codex output means we're not in a quiet window anymore.
      this.finalOnlyQuietFlushPollsByInstance.delete(params.key);
    }

    const codexAuthoritative = this.isCodexEventOutputAuthoritative(params.agentType);
    const shouldBuffer =
      codexAuthoritative ||
      (
        this.codexFinalOnlyModeEnabled &&
        params.agentType === 'codex'
      ) ||
      this.shouldBufferUntilCompletion(params.key, params.agentType, params.pendingDepth) ||
      (
        this.codexFinalOnlyModeEnabled &&
        params.agentType === 'codex' &&
        params.codexWorkingHint === true
    );
    if (shouldBuffer) {
      this.appendBufferedOutput(params.key, trimmed, params.channelId, params.agentType);
      return { observedOutput: true, emittedOutput: false };
    }

    if (this.isCodexEventOnlyActive(params.agentType)) {
      // Codex output remains event-driven while local hook bridge is enabled.
      return { observedOutput: true, emittedOutput: false };
    }

    if (params.eventHookCapture && !this.eventHookCaptureOutputEnabled) {
      // During event-hook stale fallback, keep capture for state/quiet observation unless explicitly opted in.
      return { observedOutput: true, emittedOutput: false };
    }

    if (this.shouldBatchProgressDelta(params.agentType, params.pendingDepth)) {
      const shouldFlushNow = this.appendProgressBatch({
        key: params.key,
        text: trimmed,
        channelId: params.channelId,
        outputVisibility: params.outputVisibility,
        agentType: params.agentType,
      });
      const flushed = shouldFlushNow
        ? await this.maybeFlushProgressBatch({
            key: params.key,
            fallbackChannelId: params.channelId,
            fallbackVisibility: params.outputVisibility,
            force: true,
          })
        : false;
      return { observedOutput: true, emittedOutput: flushed };
    }

    if (!params.channelId) return { observedOutput: true, emittedOutput: false };
    const sent = await this.sendOutput(
      params.channelId,
      trimmed,
      'progress',
      params.outputVisibility,
      params.agentType,
    );
    return { observedOutput: true, emittedOutput: sent };
  }

  private async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const stopPollIterationTimer = perfMetrics.startTimer('capture_poll_iteration_ms');

    try {
      const activeCaptureKeys = new Set<string>();
      const activeInstanceKeys = new Set<string>();
      const projects = this.deps.stateManager.listProjects();
      for (const rawProject of projects) {
        const project = rawProject as ReturnType<typeof normalizeProjectState>;
        const instances = listProjectInstances(rawProject);

        for (const instance of instances) {
          const key = this.captureKey(project.projectName, instance.instanceId);
          activeInstanceKeys.add(key);
          const targetWindow = instance.tmuxWindow || instance.instanceId;
          if (!targetWindow) continue;
          const reconciledMissingWorker = await this.maybeReconcileDeadWorkerInstance({
            project,
            instanceId: instance.instanceId,
            agentType: instance.agentType,
            key,
            targetWindow,
          });
          if (reconciledMissingWorker) continue;

          const pendingRouteSnapshot = this.resolvePendingRouteSnapshot(
            project.projectName,
            instance.agentType,
            instance.instanceId,
          );
          const routeInfo = this.resolveOutputRoute(
            instance.channelId,
            pendingRouteSnapshot,
          );
          const pendingTurnId = pendingRouteSnapshot.messageId;
          const previousPendingTurnId = this.lastPendingTurnIdByInstance.get(key);
          if (pendingTurnId) {
            this.lastPendingTurnIdByInstance.set(key, pendingTurnId);
            if (previousPendingTurnId && previousPendingTurnId !== pendingTurnId) {
              this.progressHookInFlightByInstance.delete(key);
              this.codexFinalHookTurnByInstance.delete(key);
              const retryState = this.supervisorFinalFormatRetryStateByInstance.get(key);
              if (!retryState || retryState.lastTurnId !== pendingTurnId) {
                this.supervisorFinalFormatRetryStateByInstance.delete(key);
              }
            }
          }
          const pendingActive = routeInfo.pendingDepth > 0 || typeof pendingTurnId === 'string';
          if (!instance.channelId && !routeInfo.channelId && !pendingActive && !this.hasActiveCaptureState(key)) {
            // Hidden/worker instances may not have an instance channel mapping.
            // Still capture when pending route state exists, otherwise skip idle windows.
            continue;
          }
          activeCaptureKeys.add(key);
          const eventHookDriven = this.isEventHookDrivenInstance(instance.agentType, instance.eventHook);
          let eventHookCapture = false;
          const workerOutputVisibility = this.resolveWorkerOutputVisibility({
            project,
            agentType: instance.agentType,
            instanceId: instance.instanceId,
          });

          if (
            this.shouldApplyIdleSkip(instance.agentType, workerOutputVisibility) &&
            this.idleRefreshPolls > 0 &&
            !pendingActive &&
            !this.hasActiveCaptureState(key) &&
            this.snapshotsByInstance.has(key)
          ) {
            const idleSkipThreshold = this.resolveIdleSkipThreshold(key);
            const idleSkips = (this.idleSkipPollsByInstance.get(key) || 0) + 1;
            if (idleSkips <= idleSkipThreshold) {
              this.idleSkipPollsByInstance.set(key, idleSkips);
              continue;
            }
            this.idleSkipPollsByInstance.set(key, 0);
            this.bumpIdleSkipBackoff(key);
          } else {
            this.idleSkipPollsByInstance.delete(key);
            this.idleSkipBackoffByInstance.delete(key);
          }

          if (eventHookDriven) {
            const fallback = this.shouldCaptureEventHookInstance(
              project.projectName,
              instance.instanceId,
              instance.agentType,
              key,
              pendingActive,
            );
            if (!fallback) continue;
            eventHookCapture = true;
          } else {
            this.eventHookFallbackActiveByInstance.delete(key);
            this.eventHookStaleSinceByInstance.delete(key);
          }

          const now = Date.now();

          let captureRaw: string;
          try {
            captureRaw = this.deps.tmux.capturePaneFromWindow(
              project.tmuxSession,
              targetWindow,
              instance.agentType,
            );
          } catch {
            continue;
          }

          if (typeof captureRaw !== 'string') continue;
          const previousRawSnapshot = this.rawCaptureSnapshotByInstance.get(key);
          if (previousRawSnapshot && previousRawSnapshot.raw === captureRaw) {
            const unchangedSnapshot = previousRawSnapshot.cleaned;
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              unchangedSnapshot,
              workerOutputVisibility,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          const current = cleanCapture(captureRaw);
          this.rawCaptureSnapshotByInstance.set(key, {
            raw: captureRaw,
            cleaned: current,
          });
          if (!current || current.trim().length === 0) {
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
              workerOutputVisibility,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          const previous = this.snapshotsByInstance.get(key);
          this.snapshotsByInstance.set(key, current);

          // First snapshot establishes baseline and avoids sending historical backlog.
          if (previous === undefined) {
            this.markCaptureMutation(key, now);
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
              workerOutputVisibility,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          if (previous === current) {
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
              workerOutputVisibility,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          this.markCaptureMutation(key, now);

          const delta = this.normalizeDeltaForAgent(
            instance.agentType,
            this.extractDelta(instance.agentType, previous, current),
            previous,
            current,
          );
          const codexWorkingHint =
            instance.agentType === 'codex' && this.hasCodexWorkingMarker(current);
          const normalizedForPendingPrompt = this.promptEchoFilterEnabled
            ? this.stripPendingPromptEcho(
                instance.agentType,
                routeInfo.pendingDepth,
                delta,
                pendingRouteSnapshot.promptTails,
              )
            : delta;
          const trimmedDelta = normalizedForPendingPrompt.trim();
          if (trimmedDelta.length === 0) {
            const suppressedByPromptEcho = delta.trim().length > 0;
            if (suppressedByPromptEcho) {
              const nextSuppressedCount = (this.promptEchoSuppressedPollsByInstance.get(key) || 0) + 1;
              this.promptEchoSuppressedPollsByInstance.set(key, nextSuppressedCount);

              if (nextSuppressedCount <= this.promptEchoSuppressionMaxPolls) {
                // Treat prompt-echo-only frames as activity for a short buffer.
                // This avoids premature completion before real assistant output.
                this.quietPendingPollsByInstance.delete(key);
                continue;
              }

              // Failsafe: after repeated suppressions, stop swallowing deltas.
              // This avoids "typing forever" when filtering is too aggressive.
              this.promptEchoSuppressedPollsByInstance.delete(key);
              if (instance.agentType === 'codex' && eventHookCapture) {
                await this.handleQuietPending(
                  key,
                  routeInfo.pendingDepth,
                  project.projectName,
                  instance.agentType,
                  instance.instanceId,
                  routeInfo.channelId || instance.channelId,
                  current,
                  workerOutputVisibility,
                );
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
                continue;
              }
              const outputChannelId = routeInfo.channelId;
              if (
                !outputChannelId &&
                !this.shouldBufferUntilCompletion(key, instance.agentType, routeInfo.pendingDepth)
              ) {
                await this.handleQuietPending(
                  key,
                  routeInfo.pendingDepth,
                  project.projectName,
                  instance.agentType,
                  instance.instanceId,
                  routeInfo.channelId || instance.channelId,
                  current,
                  workerOutputVisibility,
                );
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
                continue;
              }

              const fallbackDelivery = await this.deliverDelta({
                projectName: project.projectName,
                instanceId: instance.instanceId,
                key,
                agentType: instance.agentType,
                pendingDepth: routeInfo.pendingDepth,
                codexWorkingHint,
                eventHookCapture,
                channelId: outputChannelId,
                outputVisibility: workerOutputVisibility,
                deltaText: delta,
              });
              if (fallbackDelivery.observedOutput) {
                this.quietPendingPollsByInstance.delete(key);
                if (routeInfo.pendingDepth > 0) {
                  this.completionCandidatesByInstance.set(key, {
                    projectName: project.projectName,
                    agentType: instance.agentType,
                    instanceId: instance.instanceId,
                  });
                } else {
                  this.completionCandidatesByInstance.delete(key);
                }
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
              } else {
                await this.handleQuietPending(
                  key,
                  routeInfo.pendingDepth,
                  project.projectName,
                  instance.agentType,
                  instance.instanceId,
                  routeInfo.channelId || instance.channelId,
                  current,
                  workerOutputVisibility,
                );
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
              }
              continue;
            }
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
              workerOutputVisibility,
            );
            continue;
          }

          this.promptEchoSuppressedPollsByInstance.delete(key);
          const outputChannelId = routeInfo.channelId;
          if (!outputChannelId && !this.shouldBufferUntilCompletion(key, instance.agentType, routeInfo.pendingDepth)) {
            continue;
          }

          const delivery = await this.deliverDelta({
            projectName: project.projectName,
            instanceId: instance.instanceId,
            key,
            agentType: instance.agentType,
            pendingDepth: routeInfo.pendingDepth,
            codexWorkingHint,
            eventHookCapture,
            channelId: outputChannelId,
            outputVisibility: workerOutputVisibility,
            deltaText: trimmedDelta,
          });

          if (delivery.observedOutput) {
            this.quietPendingPollsByInstance.delete(key);
            if (routeInfo.pendingDepth > 0) {
              // Keep completion buffered until output has been quiet long enough.
              this.completionCandidatesByInstance.set(key, {
                projectName: project.projectName,
                agentType: instance.agentType,
                instanceId: instance.instanceId,
              });
            } else {
              this.completionCandidatesByInstance.delete(key);
            }
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
          } else {
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
              workerOutputVisibility,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
          }
        }
      }
      this.pruneProgressHookBurstStates(activeCaptureKeys);
      this.pruneMissingWorkerWindowPolls(activeInstanceKeys);
    } catch (error) {
      console.warn(`Capture poller iteration failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stopPollIterationTimer();
      this.running = false;
    }
  }

  private async handleQuietPending(
    key: string,
    pendingDepth: number,
    projectName: string,
    agentType: string,
    instanceId: string,
    channelId?: string,
    captureSnapshot?: string,
    outputVisibility?: ProgressOutputVisibility,
  ): Promise<void> {
    await this.maybeFlushProgressBatch({
      key,
      fallbackChannelId: channelId,
      fallbackVisibility: outputVisibility,
      quietEvent: true,
      force: pendingDepth <= 0,
    });

    if (pendingDepth <= 0) {
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      if (this.codexFinalOnlyModeEnabled && agentType === 'codex') {
        const codexStillWorking =
          typeof captureSnapshot === 'string' &&
          this.hasCodexWorkingMarker(captureSnapshot);
        if (codexStillWorking) {
          // Tracker may temporarily desync to depth=0 while Codex is still working.
          // Keep final-only buffer until the working marker disappears.
          this.finalOnlyQuietFlushPollsByInstance.delete(key);
          this.maybeEmitCodexProgressEvent({
            projectName,
            instanceId,
            key,
            pendingDepth,
            codexWorkingHint: true,
            channelId,
          });
          return;
        }

        const hasBufferedOutput = this.bufferedOutputByInstance.has(key);
        if (!hasBufferedOutput) {
          this.finalOnlyQuietFlushPollsByInstance.delete(key);
          this.supervisorFinalFormatRetryStateByInstance.delete(key);
          this.progressHookHeartbeatByInstance.delete(key);
          this.progressHookInFlightByInstance.delete(key);
          this.progressHookBurstByInstance.delete(key);
          return;
        }

        if (this.isCodexEventOnlyActive(agentType)) {
          const emitted = await this.flushBufferedOutput({
            key,
            channelId,
            agentType,
            projectName,
            instanceId,
            outputVisibility,
          });
          if (emitted) {
            this.finalOnlyQuietFlushPollsByInstance.delete(key);
          }
          return;
        }

        const quietFlushThreshold = Math.max(1, this.quietPendingPollThreshold);
        const nextQuietPolls = (this.finalOnlyQuietFlushPollsByInstance.get(key) || 0) + 1;
        if (nextQuietPolls < quietFlushThreshold) {
          this.finalOnlyQuietFlushPollsByInstance.set(key, nextQuietPolls);
          return;
        }

        await this.flushBufferedOutput({
          key,
          channelId,
          agentType,
          projectName,
          instanceId,
          outputVisibility,
        });
        this.finalOnlyQuietFlushPollsByInstance.delete(key);
        return;
      }
      if (this.isCodexEventOnlyActive(agentType)) {
        const turnId = this.lastPendingTurnIdByInstance.get(key);
        if (turnId) {
          const emitted = await this.safeEmitCodexFinalEvent({
            key,
            projectName,
            instanceId,
            turnId,
            channelId,
            text: '',
          });
          if (!emitted) {
            return;
          }
        }
      }
      this.progressHookHeartbeatByInstance.delete(key);
      this.progressHookInFlightByInstance.delete(key);
      this.progressHookBurstByInstance.delete(key);
      this.supervisorFinalFormatRetryStateByInstance.delete(key);
      return;
    }

    this.finalOnlyQuietFlushPollsByInstance.delete(key);

    const hasOutputCandidate = this.completionCandidatesByInstance.has(key);
    const codexStillWorking =
      agentType === 'codex' &&
      typeof captureSnapshot === 'string' &&
      this.hasCodexWorkingMarker(captureSnapshot);
    if (codexStillWorking) {
      // Do not auto-complete while Codex still indicates active processing.
      this.quietPendingPollsByInstance.delete(key);
      this.maybeEmitCodexProgressEvent({
        projectName,
        instanceId,
        key,
        pendingDepth,
        codexWorkingHint: true,
        channelId,
      });
      return;
    }
    if (
      agentType === 'codex' &&
      hasOutputCandidate &&
      typeof captureSnapshot === 'string' &&
      this.isLikelyCodexReadyForInput(captureSnapshot)
    ) {
      if (this.isCodexEventOnlyActive(agentType)) {
        const emitted = await this.flushBufferedOutput({
          key,
          channelId,
          agentType,
          projectName,
          instanceId,
          outputVisibility,
        });
        if (emitted) {
          this.deps.ioTracker?.recordTurnCompleted({
            projectName,
            instanceId,
            channelId,
            reason: 'input-ready-event-final',
          });
          this.quietPendingPollsByInstance.delete(key);
          this.completionCandidatesByInstance.delete(key);
          return;
        }
      } else if (!this.codexFinalOnlyModeEnabled) {
        await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceId).catch(() => undefined);
        this.deps.ioTracker?.recordTurnCompleted({
          projectName,
          instanceId,
          channelId,
          reason: 'input-ready-marker',
        });
        this.quietPendingPollsByInstance.delete(key);
        this.completionCandidatesByInstance.delete(key);
        return;
      }
    }

    const quietThreshold = this.resolveQuietCompletionThreshold(hasOutputCandidate, agentType);
    if (quietThreshold <= 0) {
      this.quietPendingPollsByInstance.delete(key);
      return;
    }

    const current = this.quietPendingPollsByInstance.get(key);
    const nextCount = (current?.count || 0) + 1;
    if (nextCount >= quietThreshold) {
      if (agentType === 'codex' && this.isCodexEventOnlyActive(agentType) && hasOutputCandidate) {
        const emitted = await this.flushBufferedOutput({
          key,
          channelId,
          agentType,
          projectName,
          instanceId,
          outputVisibility,
        });
        if (emitted) {
          this.deps.ioTracker?.recordTurnCompleted({
            projectName,
            instanceId,
            channelId,
            reason: 'event-final-quiet-threshold',
          });
          this.quietPendingPollsByInstance.delete(key);
          this.completionCandidatesByInstance.delete(key);
          return;
        }
        this.quietPendingPollsByInstance.set(key, {
          count: quietThreshold,
          projectName,
          agentType,
          instanceId,
        });
        return;
      }

      await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceId).catch(() => undefined);
      if (agentType === 'codex') {
        this.deps.ioTracker?.recordTurnCompleted({
          projectName,
          instanceId,
          channelId,
          reason: 'quiet-threshold',
        });
      }
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      return;
    }

    this.quietPendingPollsByInstance.set(key, {
      count: nextCount,
      projectName,
      agentType,
      instanceId,
    });
  }

  private resolveQuietCompletionThreshold(hasOutputCandidate: boolean, agentType: string): number {
    if (agentType === 'codex' && this.isCodexEventOnlyActive(agentType)) {
      // In event-driven mode, never auto-complete without output; emit final hook
      // after quiet stabilization when output exists.
      return hasOutputCandidate ? this.quietPendingPollThreshold : 0;
    }
    if (hasOutputCandidate) {
      return this.quietPendingPollThreshold;
    }
    if (agentType === 'codex') {
      return this.codexInitialQuietPendingPollThreshold;
    }
    return this.quietPendingPollThreshold;
  }

  private captureKey(projectName: string, instanceId: string): string {
    return `${projectName}::${instanceId}`;
  }

  private resolveWorkerOutputVisibility(params: {
    project: ReturnType<typeof normalizeProjectState>;
    agentType: string;
    instanceId: string;
  }): ProgressOutputVisibility | undefined {
    const visibility = resolveOrchestratorWorkerVisibility({
      project: params.project,
      agentType: params.agentType,
      instanceId: params.instanceId,
    });
    if (!visibility) return undefined;
    if (visibility === 'hidden') return 'off';
    if (visibility === 'thread') return 'thread';
    return 'channel';
  }

  private resolveOutputRoute(
    defaultChannelId: string | undefined,
    pendingSnapshot: PendingRouteSnapshot,
  ): { channelId: string | undefined; pendingDepth: number } {
    const pendingChannel = pendingSnapshot.channelId;
    const pendingDepth = pendingSnapshot.pendingDepth;

    if (pendingDepth > 1) {
      return { channelId: defaultChannelId || pendingChannel, pendingDepth };
    }

    return { channelId: pendingChannel || defaultChannelId, pendingDepth };
  }

  private stripPendingPromptEcho(
    agentType: string,
    pendingDepth: number,
    delta: string,
    pendingPromptTails?: string[],
  ): string {
    if (pendingDepth <= 0) return delta;
    if (agentType !== 'codex') return delta;

    const promptNorms = (pendingPromptTails || [])
      .map((tail) => this.normalizePromptFragment(tail))
      .filter((tail) => tail.length > 0);
    if (promptNorms.length === 0) return delta;

    const lines = delta.split('\n');
    let dropCount = 0;
    const maxScanLines = pendingDepth === 1 ? 16 : 4;

    for (let i = 0; i < Math.min(lines.length, maxScanLines); i += 1) {
      const normalizedLine = this.normalizePromptFragment(lines[i] || '');
      if (normalizedLine.length === 0) {
        dropCount += 1;
        continue;
      }

      if (/^(assistant|system|user)\s*:/i.test(normalizedLine)) break;

      const looksLikePromptEcho =
        pendingDepth === 1
          ? this.isLikelyPromptEchoLine(promptNorms[0]!, normalizedLine)
          : this.isLikelyMultiPendingPromptEchoLine(promptNorms, normalizedLine);
      if (!looksLikePromptEcho) break;
      dropCount += 1;
    }

    if (pendingDepth === 1) {
      for (let end = Math.max(2, dropCount + 1); end <= Math.min(lines.length, maxScanLines); end += 1) {
        const block = this.normalizePromptFragment(lines.slice(0, end).join(' '));
        if (/^(assistant|system|user)\s*:/i.test(block)) break;
        if (!this.isLikelyPromptEchoBlock(promptNorms[0]!, block)) break;
        dropCount = end;
      }
    }

    if (dropCount === 0) return delta;
    return lines.slice(dropCount).join('\n');
  }

  private normalizePromptFragment(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    // Codex renders the input row with a leading prompt marker.
    // Normalize it away so pending echo matching can use raw prompt text.
    return compact.replace(/^›\s+/, '');
  }

  private isLikelyPromptEchoLine(promptNorm: string, normalizedLine: string): boolean {
    if (normalizedLine === promptNorm) return true;
    if (normalizedLine.length < 16) return false;

    // Wrapped terminal echo often appears as a leading/trailing fragment of the
    // submitted prompt. Keep this strict to avoid stripping real assistant text.
    if (promptNorm.startsWith(normalizedLine) && normalizedLine.length >= 24) return true;
    if (promptNorm.endsWith(normalizedLine) && normalizedLine.length >= 24) return true;

    return false;
  }

  private isLikelyPromptEchoBlock(promptNorm: string, normalizedBlock: string): boolean {
    if (normalizedBlock.length === 0) return false;
    if (normalizedBlock === promptNorm) return true;
    if (normalizedBlock.length < 24) return false;

    if (promptNorm.startsWith(normalizedBlock)) return true;
    if (promptNorm.endsWith(normalizedBlock)) return true;
    if (normalizedBlock.length >= 48 && promptNorm.includes(normalizedBlock)) return true;
    return false;
  }

  private isLikelyMultiPendingPromptEchoLine(promptNorms: string[], normalizedLine: string): boolean {
    if (normalizedLine.length < 48) return false;

    return promptNorms.some((promptNorm) => {
      if (normalizedLine === promptNorm) return true;
      return promptNorm.includes(normalizedLine);
    });
  }

  private extractDelta(agentType: string, previous: string, current: string): string {
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }

    const overlap = this.longestSuffixPrefix(previous, current);
    if (overlap > 0) {
      return current.slice(overlap);
    }

    return this.extractDeltaByLineAnchor(agentType, previous, current);
  }

  private longestSuffixPrefix(left: string, right: string): number {
    const max = Math.min(left.length, right.length);

    for (let len = max; len > 0; len -= 1) {
      if (left.endsWith(right.slice(0, len))) {
        return len;
      }
    }

    return 0;
  }

  private isTailAnchorLikelyUnstableForAgent(
    agentType: string,
    line: string,
    anchorIndex: number,
    totalLines: number,
  ): boolean {
    if (agentType !== 'codex') return false;

    const distanceFromBottom = Math.max(0, totalLines - 1 - anchorIndex);
    // The very last line in Codex is commonly HUD/footer noise.
    if (distanceFromBottom === 0) return true;
    if (distanceFromBottom > 3) return false;

    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;
    if (this.isCodexUiStatusNoiseLine(compact)) return true;
    if (/^esc to interrupt\b/i.test(compact)) return true;
    if (/^›\s+/.test(compact)) return true;

    return false;
  }

  private extractDeltaByLineAnchor(agentType: string, previous: string, current: string): string {
    const prevLines = previous.split('\n');
    const currLines = current.split('\n');
    if (currLines.length === 0) return '';
    let foundTailAnchorOnly = false;

    // Use the most recent stable line from previous snapshot as an anchor.
    for (let i = prevLines.length - 1; i >= 0; i -= 1) {
      const line = prevLines[i];
      if (line.trim().length === 0) continue;
      const anchor = currLines.lastIndexOf(line);
      if (anchor >= 0 && anchor < currLines.length - 1) {
        if (this.isTailAnchorLikelyUnstableForAgent(agentType, line, anchor, currLines.length)) {
          foundTailAnchorOnly = true;
          continue;
        }
        return currLines.slice(anchor + 1).join('\n');
      }
      if (anchor === currLines.length - 1) {
        // For full-screen TUI redraws, the bottom status line often stays
        // identical while content above changes completely. Keep scanning for
        // a better anchor; if we only find tail anchors, fall back to tail.
        foundTailAnchorOnly = true;
        continue;
      }
    }

    if (foundTailAnchorOnly) {
      return currLines.slice(Math.max(0, currLines.length - this.redrawFallbackTailLines)).join('\n');
    }

    // As a last resort for full-screen redraws, send only the tail.
    return currLines.slice(Math.max(0, currLines.length - this.redrawFallbackTailLines)).join('\n');
  }

  private normalizeDeltaForAgent(
    agentType: string,
    delta: string,
    previous: string,
    current: string,
  ): string {
    let normalized = delta;

    if (agentType === 'codex') {
      normalized = this.stripCodexBootstrapNoise(normalized);

      // Full-screen redraws can still look like huge deltas; reduce to tail.
      if (normalized.length > 4000 && !current.startsWith(previous)) {
        const lines = normalized.split('\n');
        normalized = lines.slice(Math.max(0, lines.length - 24)).join('\n');
      }
    }

    return normalized;
  }

  private stripCodexBootstrapNoise(text: string): string {
    const lines = text.split('\n');
    const compactNonEmpty = lines
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);
    if (this.isLikelyCodexDraftLeak(compactNonEmpty)) {
      return '';
    }

    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (/^export AGENT_DISCORD_[A-Z_]+=/.test(trimmed)) return false;
      if (/^\$?\s*cd\s+".*"\s*&&\s*codex\b/.test(trimmed)) return false;
      // Codex input row echo (e.g. "› Write tests for @filename") is not output.
      if (/^›(?:\s.*)?$/.test(trimmed)) return false;
      if (this.isCodexUiProgressNoiseLine(trimmed)) return false;
      if (this.isCodexUiStatusNoiseLine(trimmed)) return false;
      return true;
    });
    return filtered.join('\n');
  }

  private isLikelyCodexDraftLeak(compactLines: string[]): boolean {
    if (compactLines.length === 0) return false;

    const hasProgressNoise = compactLines.some((line) => this.isCodexUiProgressNoiseLine(line));
    const hasInteractivePromptEcho = compactLines.some((line) => /\bSelect action \[\d+-\d+\]/i.test(line));
    const diffStyleCount = compactLines.filter((line) => this.isCodexDiffLikeLine(line)).length;
    const numberedCodeLikeCount = compactLines.filter((line) => /^\d+\s{2,}\S/.test(line)).length;
    const hasPatchHeader = compactLines.some((line) => /^(diff --git|@@\s|(?:\+\+\+|---)\s)/.test(line));

    if (hasProgressNoise && (diffStyleCount >= 2 || hasInteractivePromptEcho || numberedCodeLikeCount >= 6 || hasPatchHeader)) {
      return true;
    }
    if (hasInteractivePromptEcho && diffStyleCount >= 2 && numberedCodeLikeCount >= 4) {
      return true;
    }
    return false;
  }

  private isCodexDiffLikeLine(line: string): boolean {
    if (/^\d+\s+[+-]\s+/.test(line)) return true;
    if (/^(?:\+\+\+|---)\s+\S/.test(line)) return true;
    if (/^@@\s+/.test(line)) return true;
    if (/^diff --git\b/.test(line)) return true;
    return false;
  }

  private isCodexUiProgressNoiseLine(line: string): boolean {
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return false;

    // Codex often renders transient progress lines while drafting.
    // These are not final user-facing output and should not be bridged.
    if (/^[•·]\s*(crafting|thinking|analyzing|analysis|planning|preparing|reviewing|searching|reading|writing|editing|running|checking|executing|building|debugging|investigating|summarizing|drafting)\b/i.test(compact)) {
      return true;
    }
    if (/^[•·]\s*.+\([0-9smh\s]+\s*[•·]\s*esc to interrupt\)$/i.test(compact)) {
      return true;
    }
    if (/^(?:[•·]\s*)?working\s*\(\d+\s*[smh]\s*[•·]\s*esc to interrupt\)$/i.test(compact)) {
      return true;
    }
    // Strong fallback: any transient UI row that still contains this marker
    // should be filtered, except explicit role-prefixed model messages.
    if (/\besc to interrupt\b/i.test(compact) && !/^(assistant|system|user)\s*:/i.test(compact)) {
      return true;
    }
    if (/^esc to interrupt\b/i.test(compact)) return true;
    return false;
  }

  private isCodexUiStatusNoiseLine(line: string): boolean {
    // Codex TUI footer noise can be wrapped/truncated while percentages change.
    // Examples:
    //   "? for shortcuts ... 95% context left"
    //   "rfor shortcuts t ... 94% context left"
    //   "95% context left"
    //   "gpt-5.3-codex xhigh · 99% left · ~/repo/path"
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;

    const hasShortcuts = /for shortcuts/i.test(compact);
    const hasContextPct = /\b\d{1,3}%\s*context left\b/i.test(compact);
    if (hasShortcuts && hasContextPct) return true;

    if (/^\d{1,3}%\s*context left$/i.test(compact)) return true;
    if (/^\??\s*for shortcuts$/i.test(compact)) return true;
    if (/^tab to queue message(?:\s+\d{1,3}%\s*(?:context\s*)?left)?$/i.test(compact)) return true;
    if (/^.+[·•]\s*\d{1,3}%\s*left\s*[·•]\s*(?:~\/|\/).+$/i.test(compact)) return true;

    return false;
  }
}
