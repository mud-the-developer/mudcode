import { createServer } from 'http';
import { parse } from 'url';
import { existsSync, realpathSync } from 'fs';
import { basename, resolve } from 'path';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../../capture/parser.js';
import type { MessagingClient } from '../../messaging/interface.js';
import type { IStateManager } from '../../types/interfaces.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../../state/instances.js';
import { PendingMessageTracker, type PendingRuntimeSnapshot } from './pending-message-tracker.js';
import { formatDiscordOutput, wrapDiscordCodeblock } from '../formatting/discord-output-formatter.js';

const LONG_OUTPUT_THREAD_THRESHOLD_MIN = 1200;
const LONG_OUTPUT_THREAD_THRESHOLD_MAX = 20000;
const LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX = 100000;
type EventProgressForwardMode = 'off' | 'thread' | 'channel';
type EventProgressActiveMode = Exclude<EventProgressForwardMode, 'off'>;
type EventLifecycleStrictMode = 'off' | 'warn' | 'reject';

interface ProgressBlockState {
  key: string;
  projectName: string;
  agentType: string;
  instanceId?: string;
  turnId?: string;
  channelId: string;
  mode: EventProgressActiveMode;
  text: string;
}

interface ResolvedProgressEventConfig {
  mode: EventProgressForwardMode;
  blockStreamingEnabled: boolean;
  blockWindowMs: number;
  blockMaxChars: number;
}

interface EventOnlyProgressGateResult {
  mode: EventProgressForwardMode;
  adjusted: boolean;
  reason?: 'event-only-channel-blocked' | 'event-only-thread-unavailable';
}

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  reloadChannelMappings: () => void;
}

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;
  private ignoredEventsByInstance = new Map<
    string,
    { count: number; byType: Record<string, number>; lastIgnoredAtMs: number }
  >();
  private lifecycleRejectedEventsByInstance = new Map<
    string,
    { count: number; byType: Record<string, number>; lastRejectedAtMs: number }
  >();
  private processedEventIds = new Map<string, number>();
  private eventLifecycleByInstance = new Map<
    string,
    {
      stage: 'idle' | 'started' | 'progress' | 'final' | 'error' | 'cancelled';
      turnId?: string;
      eventId?: string;
      seq?: number;
      updatedAtMs: number;
    }
  >();
  private latestSeqByTurn = new Map<string, { seq: number; updatedAtMs: number }>();
  private startedTurnsByKey = new Map<string, number>();
  private progressBlocksByKey = new Map<string, ProgressBlockState>();
  private progressBlockTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();
  private progressTranscriptByTurn = new Map<string, { text: string; updatedAtMs: number }>();
  private progressModeByTurn = new Map<string, { mode: EventProgressForwardMode; updatedAtMs: number }>();

  constructor(private deps: BridgeHookServerDeps) {}

  private runtimeKey(projectName: string, instanceId: string): string {
    return `${projectName}:${instanceId}`;
  }

  private markIgnoredEvent(
    projectName: string,
    instanceId: string,
    eventType?: string,
  ): void {
    const key = this.runtimeKey(projectName, instanceId);
    const current = this.ignoredEventsByInstance.get(key) || {
      count: 0,
      byType: {},
      lastIgnoredAtMs: Date.now(),
    };
    current.count += 1;
    const typeKey = typeof eventType === 'string' && eventType.trim().length > 0 ? eventType.trim() : 'unknown';
    current.byType[typeKey] = (current.byType[typeKey] || 0) + 1;
    current.lastIgnoredAtMs = Date.now();
    this.ignoredEventsByInstance.set(key, current);
  }

  private getIgnoredEventSnapshot(
    projectName: string,
    instanceId: string,
  ): { ignoredEventCount: number; ignoredEventTypes: Record<string, number>; ignoredLastAt: string } | undefined {
    const key = this.runtimeKey(projectName, instanceId);
    const snapshot = this.ignoredEventsByInstance.get(key);
    if (!snapshot || snapshot.count <= 0) return undefined;
    return {
      ignoredEventCount: snapshot.count,
      ignoredEventTypes: { ...snapshot.byType },
      ignoredLastAt: new Date(snapshot.lastIgnoredAtMs).toISOString(),
    };
  }

  private markLifecycleRejectedEvent(
    projectName: string,
    instanceId: string,
    eventType?: string,
  ): void {
    const key = this.runtimeKey(projectName, instanceId);
    const current = this.lifecycleRejectedEventsByInstance.get(key) || {
      count: 0,
      byType: {},
      lastRejectedAtMs: Date.now(),
    };
    current.count += 1;
    const typeKey = typeof eventType === 'string' && eventType.trim().length > 0 ? eventType.trim() : 'unknown';
    current.byType[typeKey] = (current.byType[typeKey] || 0) + 1;
    current.lastRejectedAtMs = Date.now();
    this.lifecycleRejectedEventsByInstance.set(key, current);
  }

  private getLifecycleRejectedEventSnapshot(
    projectName: string,
    instanceId: string,
  ): {
    lifecycleRejectedEventCount: number;
    lifecycleRejectedEventTypes: Record<string, number>;
    lifecycleRejectedLastAt: string;
  } | undefined {
    const key = this.runtimeKey(projectName, instanceId);
    const snapshot = this.lifecycleRejectedEventsByInstance.get(key);
    if (!snapshot || snapshot.count <= 0) return undefined;
    return {
      lifecycleRejectedEventCount: snapshot.count,
      lifecycleRejectedEventTypes: { ...snapshot.byType },
      lifecycleRejectedLastAt: new Date(snapshot.lastRejectedAtMs).toISOString(),
    };
  }

  private resolveIgnoredEventRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_IGNORED_EVENT_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 60_000) {
      return Math.trunc(fromEnv);
    }
    return 24 * 60 * 60 * 1000;
  }

  private pruneIgnoredEvents(activeInstanceKeys: Set<string>): void {
    if (this.ignoredEventsByInstance.size === 0) return;
    const now = Date.now();
    const retentionMs = this.resolveIgnoredEventRetentionMs();
    for (const [key, snapshot] of this.ignoredEventsByInstance.entries()) {
      if (activeInstanceKeys.has(key)) continue;
      if (now - snapshot.lastIgnoredAtMs <= retentionMs) continue;
      this.ignoredEventsByInstance.delete(key);
    }
  }

  private pruneLifecycleRejectedEvents(activeInstanceKeys: Set<string>): void {
    if (this.lifecycleRejectedEventsByInstance.size === 0) return;
    const now = Date.now();
    const retentionMs = this.resolveIgnoredEventRetentionMs();
    for (const [key, snapshot] of this.lifecycleRejectedEventsByInstance.entries()) {
      if (activeInstanceKeys.has(key)) continue;
      if (now - snapshot.lastRejectedAtMs <= retentionMs) continue;
      this.lifecycleRejectedEventsByInstance.delete(key);
    }
  }

  private resolveEventDedupeRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_DEDUPE_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
      return Math.trunc(fromEnv);
    }
    return 10 * 60 * 1000;
  }

  private resolveEventDedupeMaxEntries(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_DEDUPE_MAX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 100 && fromEnv <= 1_000_000) {
      return Math.trunc(fromEnv);
    }
    return 50_000;
  }

  private resolveEventLifecycleStaleMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STALE_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
      return Math.trunc(fromEnv);
    }
    return 120_000;
  }

  private resolveEventSeqRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_SEQ_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
      return Math.trunc(fromEnv);
    }
    return 30 * 60 * 1000;
  }

  private resolveEventSeqMaxEntries(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_SEQ_MAX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 100 && fromEnv <= 1_000_000) {
      return Math.trunc(fromEnv);
    }
    return 100_000;
  }

  private resolveEventLifecycleStrictMode(): EventLifecycleStrictMode {
    const raw = (process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'warn' || raw === 'reject') {
      return raw;
    }
    return 'off';
  }

  private resolveStartedTurnRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_STARTED_TURN_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 5_000) {
      return Math.trunc(fromEnv);
    }
    return 30 * 60 * 1000;
  }

  private pruneProcessedEventIds(nowMs: number): void {
    if (this.processedEventIds.size === 0) return;
    const retentionMs = this.resolveEventDedupeRetentionMs();
    for (const [key, atMs] of this.processedEventIds.entries()) {
      if (nowMs - atMs > retentionMs) {
        this.processedEventIds.delete(key);
      }
    }

    const maxEntries = this.resolveEventDedupeMaxEntries();
    while (this.processedEventIds.size > maxEntries) {
      const oldest = this.processedEventIds.keys().next();
      if (oldest.done) return;
      this.processedEventIds.delete(oldest.value);
    }
  }

  private pruneLatestSeqByTurn(nowMs: number): void {
    if (this.latestSeqByTurn.size === 0) return;
    const retentionMs = this.resolveEventSeqRetentionMs();
    for (const [key, snapshot] of this.latestSeqByTurn.entries()) {
      if (nowMs - snapshot.updatedAtMs > retentionMs) {
        this.latestSeqByTurn.delete(key);
      }
    }

    const maxEntries = this.resolveEventSeqMaxEntries();
    while (this.latestSeqByTurn.size > maxEntries) {
      const oldest = this.latestSeqByTurn.keys().next();
      if (oldest.done) return;
      this.latestSeqByTurn.delete(oldest.value);
    }
  }

  private buildTurnLifecycleKey(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): string | undefined {
    const turnId = params.turnId?.trim();
    if (!turnId) return undefined;
    return `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${turnId}`;
  }

  private pruneStartedTurns(nowMs: number): void {
    if (this.startedTurnsByKey.size === 0) return;
    const retentionMs = this.resolveStartedTurnRetentionMs();
    for (const [key, updatedAtMs] of this.startedTurnsByKey.entries()) {
      if (nowMs - updatedAtMs > retentionMs) {
        this.startedTurnsByKey.delete(key);
      }
    }
  }

  private markTurnStarted(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): void {
    const key = this.buildTurnLifecycleKey(params);
    if (!key) return;
    const now = Date.now();
    this.pruneStartedTurns(now);
    this.startedTurnsByKey.set(key, now);
  }

  private hasTurnStarted(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): boolean {
    const key = this.buildTurnLifecycleKey(params);
    if (!key) return false;
    const now = Date.now();
    this.pruneStartedTurns(now);
    return this.startedTurnsByKey.has(key);
  }

  private clearStartedTurn(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): void {
    const key = this.buildTurnLifecycleKey(params);
    if (!key) return;
    this.startedTurnsByKey.delete(key);
  }

  private shouldSkipBySequence(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
    seq?: number;
  }): boolean {
    if (!params.turnId || typeof params.seq !== 'number' || !Number.isFinite(params.seq)) return false;
    const normalizedSeq = Math.trunc(params.seq);
    if (normalizedSeq < 0) return false;

    const turnKey = `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${params.turnId}`;
    const now = Date.now();
    this.pruneLatestSeqByTurn(now);
    const current = this.latestSeqByTurn.get(turnKey);
    if (current && normalizedSeq <= current.seq) {
      return true;
    }
    this.latestSeqByTurn.set(turnKey, { seq: normalizedSeq, updatedAtMs: now });
    return false;
  }

  private checkAndRememberEventId(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    eventId?: string;
  }): boolean {
    const eventId = params.eventId?.trim();
    if (!eventId) return false;
    const dedupeKey = `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${eventId}`;
    const now = Date.now();
    this.pruneProcessedEventIds(now);
    if (this.processedEventIds.has(dedupeKey)) {
      return true;
    }
    this.processedEventIds.set(dedupeKey, now);
    return false;
  }

  private updateEventLifecycle(params: {
    projectName: string;
    instanceId: string;
    stage: 'idle' | 'started' | 'progress' | 'final' | 'error' | 'cancelled';
    turnId?: string;
    eventId?: string;
    seq?: number;
  }): void {
    const key = this.runtimeKey(params.projectName, params.instanceId);
    this.eventLifecycleByInstance.set(key, {
      stage: params.stage,
      turnId: params.turnId,
      eventId: params.eventId,
      seq: params.seq,
      updatedAtMs: Date.now(),
    });
  }

  private getEventLifecycleSnapshot(
    projectName: string,
    instanceId: string,
  ):
    | {
        eventLifecycleStage: 'idle' | 'started' | 'progress' | 'final' | 'error' | 'cancelled';
        eventLifecycleTurnId?: string;
        eventLifecycleEventId?: string;
        eventLifecycleSeq?: number;
        eventLifecycleUpdatedAt: string;
        eventLifecycleAgeMs: number;
        eventLifecycleStale?: boolean;
      }
    | undefined {
    const key = this.runtimeKey(projectName, instanceId);
    const current = this.eventLifecycleByInstance.get(key);
    if (!current) return undefined;
    const ageMs = Math.max(0, Date.now() - current.updatedAtMs);
    const staleCandidate = current.stage === 'started' || current.stage === 'progress';
    const stale = staleCandidate && ageMs >= this.resolveEventLifecycleStaleMs();
    return {
      eventLifecycleStage: current.stage,
      eventLifecycleTurnId: current.turnId,
      eventLifecycleEventId: current.eventId,
      eventLifecycleSeq: current.seq,
      eventLifecycleUpdatedAt: new Date(current.updatedAtMs).toISOString(),
      eventLifecycleAgeMs: ageMs,
      ...(stale ? { eventLifecycleStale: true } : {}),
    };
  }

  private pruneEventLifecycle(activeInstanceKeys: Set<string>): void {
    if (this.eventLifecycleByInstance.size === 0) return;
    const now = Date.now();
    const retentionMs = this.resolveIgnoredEventRetentionMs();
    for (const [key, snapshot] of this.eventLifecycleByInstance.entries()) {
      if (activeInstanceKeys.has(key)) continue;
      if (now - snapshot.updatedAtMs <= retentionMs) continue;
      this.eventLifecycleByInstance.delete(key);
    }
  }

  private resolveOutputRoute(
    defaultChannelId: string | undefined,
    projectName: string,
    agentType: string,
    instanceId?: string,
  ): { channelId: string | undefined; pendingDepth: number } {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getPendingChannel?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
    };
    const pendingChannel =
      typeof pendingTracker.getPendingChannel === 'function'
        ? pendingTracker.getPendingChannel(projectName, agentType, instanceId)
        : undefined;
    const pendingDepth =
      typeof pendingTracker.getPendingDepth === 'function'
        ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
        : pendingChannel
          ? 1
          : 0;

    if (pendingDepth > 1) {
      return { channelId: defaultChannelId || pendingChannel, pendingDepth };
    }

    return { channelId: pendingChannel || defaultChannelId, pendingDepth };
  }

  private resolveLongOutputThreadThreshold(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD || '');
    if (Number.isFinite(fromEnv) && fromEnv >= LONG_OUTPUT_THREAD_THRESHOLD_MIN) {
      const normalized = Math.trunc(fromEnv);
      if (normalized <= LONG_OUTPUT_THREAD_THRESHOLD_MAX) return normalized;
      if (normalized <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX) return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
      return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
    }
    return 2000;
  }

  private shouldUseThreadedLongOutput(text: string): boolean {
    return (
      this.deps.messaging.platform === 'discord' &&
      text.length >= this.resolveLongOutputThreadThreshold() &&
      typeof this.deps.messaging.sendLongOutput === 'function'
    );
  }

  private resolveEventProgressForwardMode(): EventProgressForwardMode {
    const raw = process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    if (!raw) return 'off';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
      return normalized;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'thread';
    if (['0', 'false', 'no'].includes(normalized)) return 'off';
    return 'off';
  }

  private resolveCodexEventOnlyModeEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return false;
  }

  private applyEventOnlyProgressModeGate(params: {
    agentType: string;
    mode: EventProgressForwardMode;
  }): EventOnlyProgressGateResult {
    if (params.agentType !== 'codex' || !this.resolveCodexEventOnlyModeEnabled()) {
      return { mode: params.mode, adjusted: false };
    }
    if (params.mode === 'off') {
      return { mode: 'off', adjusted: false };
    }

    const canUseProgressThread =
      this.deps.messaging.platform === 'discord' &&
      typeof this.deps.messaging.sendToProgressThread === 'function';
    if (!canUseProgressThread) {
      return {
        mode: 'off',
        adjusted: true,
        reason: 'event-only-thread-unavailable',
      };
    }

    if (params.mode === 'channel') {
      return {
        mode: 'thread',
        adjusted: true,
        reason: 'event-only-channel-blocked',
      };
    }

    return { mode: params.mode, adjusted: false };
  }

  private parseEventProgressForwardMode(raw: unknown): EventProgressForwardMode | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
      return normalized;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'thread';
    if (['0', 'false', 'no'].includes(normalized)) return 'off';
    return undefined;
  }

  private resolveEventProgressBlockStreamingEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveEventProgressBlockWindowMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 50 && fromEnv <= 5000) {
      return Math.trunc(fromEnv);
    }
    return 450;
  }

  private resolveEventProgressBlockMaxChars(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 200 && fromEnv <= 8000) {
      return Math.trunc(fromEnv);
    }
    return 1800;
  }

  private parseEventBoolean(raw: unknown): boolean | undefined {
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

  private parseEventInt(raw: unknown, min: number, max: number): number | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
    if (value < min || value > max) return undefined;
    return value;
  }

  private resolveProgressEventConfig(event: Record<string, unknown>): ResolvedProgressEventConfig {
    const mode =
      this.parseEventProgressForwardMode(event.progressMode) ||
      this.resolveEventProgressForwardMode();
    const blockStreamingEnabled =
      this.parseEventBoolean(event.progressBlockStreaming) ??
      this.resolveEventProgressBlockStreamingEnabled();
    const blockWindowMs =
      this.parseEventInt(event.progressBlockWindowMs, 50, 5000) ??
      this.resolveEventProgressBlockWindowMs();
    const blockMaxChars =
      this.parseEventInt(event.progressBlockMaxChars, 200, 8000) ??
      this.resolveEventProgressBlockMaxChars();
    return {
      mode,
      blockStreamingEnabled,
      blockWindowMs,
      blockMaxChars,
    };
  }

  private resolveEventProgressTranscriptMaxChars(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_TRANSCRIPT_MAX_CHARS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 500 && fromEnv <= 100_000) {
      return Math.trunc(fromEnv);
    }
    return 24_000;
  }

  private resolveEventFinalFallbackFromProgressEnabled(): boolean {
    const raw = process.env.AGENT_DISCORD_EVENT_FINAL_FROM_PROGRESS_ON_EMPTY;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private buildProgressBlockKey(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    channelId: string;
    turnId?: string;
  }): string {
    return `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${params.channelId}:${params.turnId || 'na'}`;
  }

  private longestSuffixPrefix(previous: string, incoming: string): number {
    const max = Math.min(previous.length, incoming.length);
    for (let len = max; len > 0; len -= 1) {
      if (previous.slice(previous.length - len) === incoming.slice(0, len)) {
        return len;
      }
    }
    return 0;
  }

  private mergeProgressBlockText(previous: string, incoming: string): string {
    const overlap = this.longestSuffixPrefix(previous, incoming);
    const merged = overlap > 0 ? `${previous}${incoming.slice(overlap)}` : `${previous}\n${incoming}`;
    return merged.trim();
  }

  private scheduleProgressBlockFlush(key: string, delayMs: number): void {
    if (this.progressBlockTimersByKey.has(key)) return;
    const timer = setTimeout(() => {
      this.progressBlockTimersByKey.delete(key);
      void this.flushProgressBlock(key).catch((error) => {
        console.warn(`Progress block flush failed (${key}): ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(0, Math.trunc(delayMs)));
    timer.unref?.();
    this.progressBlockTimersByKey.set(key, timer);
  }

  private clearProgressBlock(key: string): void {
    const timer = this.progressBlockTimersByKey.get(key);
    if (timer) {
      clearTimeout(timer);
      this.progressBlockTimersByKey.delete(key);
    }
    this.progressBlocksByKey.delete(key);
  }

  private clearAllProgressBlocks(): void {
    for (const key of this.progressBlocksByKey.keys()) {
      this.clearProgressBlock(key);
    }
  }

  private buildProgressTurnKey(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): string | undefined {
    const turnId = params.turnId?.trim();
    if (!turnId) return undefined;
    return `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${turnId}`;
  }

  private buildProgressRouteKey(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
  }): string {
    return `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}`;
  }

  private buildProgressModeKey(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): string {
    const turnKey = this.buildProgressTurnKey(params);
    if (turnKey) return `turn:${turnKey}`;
    return `route:${this.buildProgressRouteKey(params)}`;
  }

  private appendProgressTranscript(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
    text: string;
  }): void {
    const key = this.buildProgressTurnKey(params);
    if (!key) return;
    const incoming = params.text.trim();
    if (incoming.length === 0) return;

    const current = this.progressTranscriptByTurn.get(key);
    const merged = current ? this.mergeProgressBlockText(current.text, incoming) : incoming;
    const maxChars = this.resolveEventProgressTranscriptMaxChars();
    const clamped = merged.length > maxChars ? merged.slice(merged.length - maxChars) : merged;
    this.progressTranscriptByTurn.set(key, {
      text: clamped,
      updatedAtMs: Date.now(),
    });
  }

  private getProgressTranscript(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): string | undefined {
    const key = this.buildProgressTurnKey(params);
    if (!key) return undefined;
    const snapshot = this.progressTranscriptByTurn.get(key);
    return snapshot?.text;
  }

  private clearProgressTranscript(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): void {
    const key = this.buildProgressTurnKey(params);
    if (!key) return;
    this.progressTranscriptByTurn.delete(key);
  }

  private rememberProgressModeForTurn(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
    mode: EventProgressForwardMode;
  }): void {
    const now = Date.now();
    const key = this.buildProgressModeKey(params);
    this.progressModeByTurn.set(key, {
      mode: params.mode,
      updatedAtMs: now,
    });
    const routeKey = this.buildProgressModeKey({
      projectName: params.projectName,
      agentType: params.agentType,
      instanceId: params.instanceId,
      turnId: undefined,
    });
    this.progressModeByTurn.set(routeKey, {
      mode: params.mode,
      updatedAtMs: now,
    });
  }

  private resolveProgressModeForTurn(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): EventProgressForwardMode {
    const key = this.buildProgressModeKey(params);
    const snapshot = this.progressModeByTurn.get(key);
    if (snapshot) return snapshot.mode;
    return this.resolveEventProgressForwardMode();
  }

  private clearProgressModesForRoute(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): void {
    if (params.turnId && params.turnId.trim().length > 0) {
      this.progressModeByTurn.delete(this.buildProgressModeKey(params));
      return;
    }
    const routePrefix = `route:${this.buildProgressRouteKey(params)}`;
    const turnPrefix = `turn:${this.buildProgressRouteKey(params)}:`;
    for (const key of this.progressModeByTurn.keys()) {
      if (key === routePrefix || key.startsWith(turnPrefix)) {
        this.progressModeByTurn.delete(key);
      }
    }
  }

  private clearProgressTranscriptsForRoute(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
  }): void {
    if (params.turnId && params.turnId.trim().length > 0) {
      this.clearProgressTranscript(params);
      return;
    }
    const prefix = `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:`;
    for (const key of this.progressTranscriptByTurn.keys()) {
      if (key.startsWith(prefix)) {
        this.progressTranscriptByTurn.delete(key);
      }
    }
  }

  private pruneProgressTranscripts(activeInstanceKeys: Set<string>): void {
    if (this.progressTranscriptByTurn.size === 0) return;
    const now = Date.now();
    const retentionMs = this.resolveIgnoredEventRetentionMs();
    for (const [key, snapshot] of this.progressTranscriptByTurn.entries()) {
      const parts = key.split(':');
      const runtimeKey = parts.length >= 3 ? `${parts[0]}:${parts[2]}` : key;
      if (activeInstanceKeys.has(runtimeKey)) continue;
      if (now - snapshot.updatedAtMs <= retentionMs) continue;
      this.progressTranscriptByTurn.delete(key);
    }
  }

  private pruneProgressModes(activeInstanceKeys: Set<string>): void {
    if (this.progressModeByTurn.size === 0) return;
    const now = Date.now();
    const retentionMs = this.resolveIgnoredEventRetentionMs();
    for (const [key, snapshot] of this.progressModeByTurn.entries()) {
      const raw = key.startsWith('turn:') ? key.slice(5) : key.startsWith('route:') ? key.slice(6) : key;
      const parts = raw.split(':');
      const runtimeKey = parts.length >= 3 ? `${parts[0]}:${parts[2]}` : raw;
      if (activeInstanceKeys.has(runtimeKey)) continue;
      if (now - snapshot.updatedAtMs <= retentionMs) continue;
      this.progressModeByTurn.delete(key);
    }
  }

  private getLatestProgressModeSnapshot(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
  }): {
    eventProgressMode: EventProgressForwardMode;
    eventProgressModeTurnId?: string;
    eventProgressModeUpdatedAt: string;
    eventProgressModeAgeMs: number;
  } | undefined {
    const routeKey = this.buildProgressRouteKey(params);
    const routePrefix = `route:${routeKey}`;
    const turnPrefix = `turn:${routeKey}:`;

    let latest:
      | {
          key: string;
          mode: EventProgressForwardMode;
          updatedAtMs: number;
        }
      | undefined;

    for (const [key, snapshot] of this.progressModeByTurn.entries()) {
      if (key !== routePrefix && !key.startsWith(turnPrefix)) continue;
      const preferTurnForTie =
        !!latest &&
        snapshot.updatedAtMs === latest.updatedAtMs &&
        key.startsWith(turnPrefix) &&
        !latest.key.startsWith(turnPrefix);
      if (!latest || snapshot.updatedAtMs > latest.updatedAtMs || preferTurnForTie) {
        latest = {
          key,
          mode: snapshot.mode,
          updatedAtMs: snapshot.updatedAtMs,
        };
      }
    }

    if (!latest) return undefined;

    const turnId = latest.key.startsWith(turnPrefix)
      ? latest.key.slice(turnPrefix.length)
      : undefined;

    return {
      eventProgressMode: latest.mode,
      ...(turnId ? { eventProgressModeTurnId: turnId } : {}),
      eventProgressModeUpdatedAt: new Date(latest.updatedAtMs).toISOString(),
      eventProgressModeAgeMs: Math.max(0, Date.now() - latest.updatedAtMs),
    };
  }

  private async flushProgressBlock(key: string): Promise<void> {
    const state = this.progressBlocksByKey.get(key);
    this.clearProgressBlock(key);
    if (!state) return;
    if (!state.text || state.text.trim().length === 0) return;
    await this.sendProgressEventOutput(state.channelId, state.text, state.mode);
  }

  private async enqueueProgressBlock(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    turnId?: string;
    channelId: string;
    mode: EventProgressActiveMode;
    text: string;
    blockWindowMs: number;
    blockMaxChars: number;
  }): Promise<void> {
    const key = this.buildProgressBlockKey(params);
    const existing = this.progressBlocksByKey.get(key);
    const merged = existing ? this.mergeProgressBlockText(existing.text, params.text) : params.text.trim();
    if (merged.length === 0) return;

    this.progressBlocksByKey.set(key, {
      ...params,
      key,
      text: merged,
    });

    if (merged.length >= params.blockMaxChars) {
      await this.flushProgressBlock(key);
      return;
    }

    this.scheduleProgressBlockFlush(key, params.blockWindowMs);
  }

  private clearProgressBlocksForRoute(params: {
    projectName: string;
    agentType: string;
    instanceId?: string;
    channelId: string;
    turnId?: string;
  }): void {
    const keys = new Set<string>();
    if (params.turnId) {
      keys.add(this.buildProgressBlockKey(params));
      keys.add(this.buildProgressBlockKey({ ...params, turnId: undefined }));
    } else {
      const prefix = `${params.projectName}:${params.agentType}:${params.instanceId || 'na'}:${params.channelId}:`;
      for (const key of this.progressBlocksByKey.keys()) {
        if (key.startsWith(prefix)) {
          keys.add(key);
        }
      }
    }
    for (const key of keys) {
      this.clearProgressBlock(key);
    }
  }

  private async sendEventOutput(channelId: string, text: string): Promise<void> {
    const discordFormatted =
      this.deps.messaging.platform === 'discord'
        ? formatDiscordOutput(text)
        : { text, useCodeblock: false, language: 'text' };
    const content = discordFormatted.text;
    if (content.trim().length === 0) return;

    if (this.shouldUseThreadedLongOutput(content)) {
      await this.deps.messaging.sendLongOutput!(channelId, content);
      return;
    }

    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    for (const chunk of split(content)) {
      if (chunk.trim().length === 0) continue;
      const payload =
        this.deps.messaging.platform === 'discord' && discordFormatted.useCodeblock
          ? wrapDiscordCodeblock(chunk, discordFormatted.language)
          : chunk;
      await this.deps.messaging.sendToChannel(channelId, payload);
    }
  }

  private async sendProgressEventOutput(
    channelId: string,
    text: string,
    mode: EventProgressForwardMode = this.resolveEventProgressForwardMode(),
  ): Promise<void> {
    if (mode === 'off') return;

    const discordFormatted =
      this.deps.messaging.platform === 'discord'
        ? formatDiscordOutput(text)
        : { text, useCodeblock: false, language: 'text' };
    const content = discordFormatted.text;
    if (content.trim().length === 0) return;

    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    for (const chunk of split(content)) {
      if (chunk.trim().length === 0) continue;
      const payload =
        this.deps.messaging.platform === 'discord' && discordFormatted.useCodeblock
          ? wrapDiscordCodeblock(chunk, discordFormatted.language)
          : chunk;
      if (
        mode === 'thread' &&
        this.deps.messaging.platform === 'discord' &&
        typeof this.deps.messaging.sendToProgressThread === 'function'
      ) {
        await this.deps.messaging.sendToProgressThread(channelId, payload);
      } else {
        await this.deps.messaging.sendToChannel(channelId, payload);
      }
    }
  }

  private buildFileNotice(filePaths: string[]): string {
    const names = filePaths.map((path) => basename(path));
    if (names.length === 0) return '📎 Generated files attached.';
    if (names.length <= 3) {
      return `📎 Generated file${names.length > 1 ? 's' : ''}: ${names.map((n) => `\`${n}\``).join(', ')}`;
    }
    const head = names.slice(0, 3).map((n) => `\`${n}\``).join(', ');
    return `📎 Generated ${names.length} files: ${head}, …`;
  }

  private getRuntimeSnapshotForInstance(
    projectName: string,
    agentType: string,
    instanceId?: string,
  ): PendingRuntimeSnapshot {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getRuntimeSnapshot?: (projectName: string, agentType: string, instanceId?: string) => PendingRuntimeSnapshot;
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
    };
    if (typeof pendingTracker.getRuntimeSnapshot === 'function') {
      return pendingTracker.getRuntimeSnapshot(projectName, agentType, instanceId);
    }
    const pendingDepth =
      typeof pendingTracker.getPendingDepth === 'function'
        ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
        : 0;
    return { pendingDepth };
  }

  private buildRuntimeStatusPayload(): {
    generatedAt: string;
    instances: Array<{
      projectName: string;
      instanceId: string;
      agentType: string;
      ignoredEventCount?: number;
      ignoredEventTypes?: Record<string, number>;
      ignoredLastAt?: string;
      lifecycleRejectedEventCount?: number;
      lifecycleRejectedEventTypes?: Record<string, number>;
      lifecycleRejectedLastAt?: string;
      eventProgressMode?: EventProgressForwardMode;
      eventProgressModeTurnId?: string;
      eventProgressModeUpdatedAt?: string;
      eventProgressModeAgeMs?: number;
      eventLifecycleStage?: 'idle' | 'started' | 'progress' | 'final' | 'error' | 'cancelled';
      eventLifecycleTurnId?: string;
      eventLifecycleEventId?: string;
      eventLifecycleSeq?: number;
      eventLifecycleUpdatedAt?: string;
      eventLifecycleAgeMs?: number;
      eventLifecycleStale?: boolean;
    } & PendingRuntimeSnapshot>;
  } {
    const projects = this.deps.stateManager.listProjects().map((project) => normalizeProjectState(project));
    const activeInstanceKeys = new Set<string>();
    const instances: Array<{
      projectName: string;
      instanceId: string;
      agentType: string;
    } & PendingRuntimeSnapshot> = [];

    for (const project of projects) {
      for (const instance of listProjectInstances(project)) {
        activeInstanceKeys.add(this.runtimeKey(project.projectName, instance.instanceId));
        const ignored = this.getIgnoredEventSnapshot(project.projectName, instance.instanceId);
        const lifecycleRejected = this.getLifecycleRejectedEventSnapshot(project.projectName, instance.instanceId);
        const lifecycle = this.getEventLifecycleSnapshot(project.projectName, instance.instanceId);
        const progressMode = this.getLatestProgressModeSnapshot({
          projectName: project.projectName,
          agentType: instance.agentType,
          instanceId: instance.instanceId,
        });
        instances.push({
          projectName: project.projectName,
          instanceId: instance.instanceId,
          agentType: instance.agentType,
          ...this.getRuntimeSnapshotForInstance(project.projectName, instance.agentType, instance.instanceId),
          ...(ignored || {}),
          ...(lifecycleRejected || {}),
          ...(progressMode || {}),
          ...(lifecycle || {}),
        });
      }
    }
    this.pruneIgnoredEvents(activeInstanceKeys);
    this.pruneLifecycleRejectedEvents(activeInstanceKeys);
    this.pruneEventLifecycle(activeInstanceKeys);
    this.pruneProgressTranscripts(activeInstanceKeys);
    this.pruneProgressModes(activeInstanceKeys);

    return {
      generatedAt: new Date().toISOString(),
      instances,
    };
  }

  start(): void {
    this.httpServer = createServer(async (req, res) => {
      const { pathname } = parse(req.url || '');

      if (req.method === 'GET' && pathname === '/runtime-status') {
        const payload = this.buildRuntimeStatusPayload();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        void (async () => {
          try {
            if (pathname === '/reload') {
              this.deps.reloadChannelMappings();
              res.writeHead(200);
              res.end('OK');
              return;
            }

            if (pathname === '/send-files') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = await this.handleSendFiles(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/opencode-event' || pathname === '/agent-event') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const ok =
                pathname === '/agent-event'
                  ? await this.handleAgentEvent(payload, 'agent-event')
                  : await this.handleOpencodeEvent(payload);
              if (ok) {
                res.writeHead(200);
                res.end('OK');
              } else {
                res.writeHead(400);
                res.end('Invalid event payload');
              }
              return;
            }

            res.writeHead(404);
            res.end('Not found');
          } catch (error) {
            console.error('Request processing error:', error);
            res.writeHead(500);
            res.end('Internal error');
          }
        })();
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(this.deps.port, '127.0.0.1');
  }

  stop(): void {
    this.clearAllProgressBlocks();
    this.progressTranscriptByTurn.clear();
    this.progressModeByTurn.clear();
    this.startedTurnsByKey.clear();
    this.lifecycleRejectedEventsByInstance.clear();
    this.httpServer?.close();
    this.httpServer = undefined;
  }

  public isEventLifecycleStale(projectName: string, instanceId: string): boolean {
    const snapshot = this.getEventLifecycleSnapshot(projectName, instanceId);
    return snapshot?.eventLifecycleStale === true;
  }

  public isEventLifecycleMissingOrStale(projectName: string, instanceId: string): boolean {
    const key = this.runtimeKey(projectName, instanceId);
    const lifecycle = this.eventLifecycleByInstance.get(key);
    if (!lifecycle) return true;
    const ageMs = Math.max(0, Date.now() - lifecycle.updatedAtMs);
    const staleCandidate = lifecycle.stage === 'started' || lifecycle.stage === 'progress';
    return staleCandidate && ageMs >= this.resolveEventLifecycleStaleMs();
  }

  /**
   * Validate an array of file paths: each must exist and reside within the project directory.
   */
  private validateFilePaths(paths: string[], projectPath: string): string[] {
    if (!projectPath) return [];
    return paths.filter((p) => {
      if (!existsSync(p)) return false;
      try {
        const real = realpathSync(p);
        return real.startsWith(projectPath + '/') || real === projectPath;
      } catch {
        return false;
      }
    });
  }

  private async handleSendFiles(payload: unknown): Promise<{ status: number; message: string }> {
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const files = Array.isArray(event.files) ? (event.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];

    if (!projectName) return { status: 400, message: 'Missing projectName' };
    if (files.length === 0) return { status: 400, message: 'No files provided' };

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return { status: 404, message: 'Project not found' };

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    const routeInfo = this.resolveOutputRoute(
      instance?.channelId,
      projectName,
      resolvedAgentType,
      resolvedInstanceId,
    );
    const channelId = routeInfo.channelId;
    if (!channelId) return { status: 404, message: 'No channel found for project/agent' };

    const projectPath = project.projectPath ? resolve(project.projectPath) : '';
    const validFiles = this.validateFilePaths(files, projectPath);
    if (validFiles.length === 0) return { status: 400, message: 'No valid files' };

    console.log(
      `📤 [${projectName}/${instance?.agentType || agentType}] send-files: ${validFiles.length} file(s)`,
    );

    await this.deps.messaging.sendToChannelWithFiles(channelId, this.buildFileNotice(validFiles), validFiles);
    return { status: 200, message: 'OK' };
  }

  private getEventText(payload: Record<string, unknown>): string | undefined {
    const direct = payload.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;

    const message = payload.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    return undefined;
  }

  private isCodexPocEvent(event: Record<string, unknown>, resolvedAgentType: string): boolean {
    const source = typeof event.source === 'string' ? event.source.trim().toLowerCase() : '';
    return resolvedAgentType === 'codex' && source === 'codex-poc';
  }

  private formatAgentLabel(agentType: string): string {
    const normalized = agentType.trim().toLowerCase();
    if (normalized === 'opencode') return 'OpenCode';
    if (normalized === 'codex') return 'Codex';
    if (normalized.length === 0) return 'Agent';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private async handleAgentEvent(
    payload: unknown,
    route: 'opencode-event' | 'agent-event',
  ): Promise<boolean> {
    if (!payload || typeof payload !== 'object') return false;

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const eventId = typeof event.eventId === 'string' ? event.eventId : undefined;
    const turnId = typeof event.turnId === 'string' && event.turnId.trim().length > 0 ? event.turnId.trim() : undefined;
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? Math.trunc(event.seq) : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    if (!projectName) return false;

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return false;

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    const allowDisabledEventHook = this.isCodexPocEvent(event, resolvedAgentType);
    if (instance?.eventHook === false && !allowDisabledEventHook) {
      this.markIgnoredEvent(projectName, instance.instanceId, eventType);
      console.log(
        `⏭️ [${projectName}/${resolvedAgentType}${instance ? `#${instance.instanceId}` : ''}] ignoring ${eventType || 'unknown'} event (eventHook disabled)`,
      );
      return true;
    }

    const duplicateEvent = this.checkAndRememberEventId({
      projectName,
      agentType: resolvedAgentType,
      instanceId: resolvedInstanceId,
      eventId,
    });
    if (duplicateEvent) {
      console.log(
        `↪️ [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] dedupe skip event=${eventType || 'unknown'} eventId=${eventId || 'missing'}`,
      );
      return true;
    }
    const skipBySequence = this.shouldSkipBySequence({
      projectName,
      agentType: resolvedAgentType,
      instanceId: resolvedInstanceId,
      turnId,
      seq,
    });
    if (skipBySequence) {
      console.log(
        `↪️ [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] seq skip event=${eventType || 'unknown'} seq=${seq ?? 'missing'} turnId=${turnId || 'missing'}`,
      );
      return true;
    }
    const routeInfo = this.resolveOutputRoute(
      instance?.channelId,
      projectName,
      resolvedAgentType,
      resolvedInstanceId,
    );
    const channelId = routeInfo.channelId;
    if (!channelId) return false;
    const lifecycleStrictMode = this.resolveEventLifecycleStrictMode();
    const requiresStartEvent =
      eventType === 'session.progress' ||
      eventType === 'session.final' ||
      eventType === 'session.idle' ||
      eventType === 'session.error' ||
      eventType === 'session.cancelled';
    if (eventType === 'session.start') {
      this.markTurnStarted({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
    } else if (turnId && requiresStartEvent) {
      const started = this.hasTurnStarted({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      if (!started) {
        const warning =
          `⚠️ [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] ` +
          `received ${eventType} without prior session.start (turnId=${turnId})`;
        if (lifecycleStrictMode === 'reject') {
          if (resolvedInstanceId) {
            this.markLifecycleRejectedEvent(projectName, resolvedInstanceId, eventType);
          }
          console.log(`${warning}; strict=reject -> ignored`);
          return true;
        }
        if (lifecycleStrictMode === 'warn') {
          console.log(`${warning}; strict=warn -> accepted`);
        }
      }
    }

    if (resolvedInstanceId && eventType === 'session.start') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'started',
        turnId,
        eventId,
        seq,
      });
    }
    if (resolvedInstanceId && eventType === 'session.progress') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'progress',
        turnId,
        eventId,
        seq,
      });
    }
    if (resolvedInstanceId && eventType === 'session.final') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'final',
        turnId,
        eventId,
        seq,
      });
    }
    if (resolvedInstanceId && eventType === 'session.idle') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'final',
        turnId,
        eventId,
        seq,
      });
    }
    if (resolvedInstanceId && eventType === 'session.error') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'error',
        turnId,
        eventId,
        seq,
      });
    }
    if (resolvedInstanceId && eventType === 'session.cancelled') {
      this.updateEventLifecycle({
        projectName,
        instanceId: resolvedInstanceId,
        stage: 'cancelled',
        turnId,
        eventId,
        seq,
      });
    }

    const text = this.getEventText(event);
    console.log(
      `🔍 [${projectName}/${instance?.agentType || agentType}${instance ? `#${instance.instanceId}` : ''}] route=${route} event=${eventType} text=${text ? `(${text.length} chars) ${text.substring(0, 100)}` : '(empty)'}`,
    );

    if (eventType === 'session.error') {
      this.clearProgressBlocksForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        channelId,
        turnId,
      });
      this.clearProgressTranscriptsForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      this.clearProgressModesForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      // Fire reaction update in background – don't block message delivery
      if (turnId && typeof this.deps.pendingTracker.markErrorByMessageId === 'function') {
        this.deps.pendingTracker
          .markErrorByMessageId(projectName, resolvedAgentType, turnId, resolvedInstanceId)
          .catch(() => {});
      } else {
        this.deps.pendingTracker.markError(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
      }
      const msg = text || 'unknown error';
      await this.deps.messaging.sendToChannel(
        channelId,
        `⚠️ ${this.formatAgentLabel(resolvedAgentType)} session error: ${msg}`,
      );
      this.clearStartedTurn({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      return true;
    }

    if (eventType === 'session.start') {
      this.clearProgressBlocksForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        channelId,
        turnId,
      });
      this.clearProgressTranscriptsForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      this.clearProgressModesForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      return true;
    }

    if (eventType === 'session.progress') {
      const rawProgressConfig = this.resolveProgressEventConfig(event);
      const modeGate = this.applyEventOnlyProgressModeGate({
        agentType: resolvedAgentType,
        mode: rawProgressConfig.mode,
      });
      const progressConfig: ResolvedProgressEventConfig = {
        ...rawProgressConfig,
        mode: modeGate.mode,
      };
      if (modeGate.adjusted) {
        console.log(
          `🛡️ [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] ` +
            `event-only progress mode adjusted ${rawProgressConfig.mode} -> ${progressConfig.mode}` +
            (modeGate.reason ? ` (${modeGate.reason})` : ''),
        );
      }
      this.rememberProgressModeForTurn({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
        mode: progressConfig.mode,
      });
      if (text && text.trim().length > 0) {
        this.appendProgressTranscript({
          projectName,
          agentType: resolvedAgentType,
          instanceId: resolvedInstanceId,
          turnId,
          text: text.trim(),
        });
        if (progressConfig.mode !== 'off') {
          if (progressConfig.blockStreamingEnabled) {
            await this.enqueueProgressBlock({
              projectName,
              agentType: resolvedAgentType,
              instanceId: resolvedInstanceId,
              turnId,
              channelId,
              mode: progressConfig.mode,
              text: text.trim(),
              blockWindowMs: progressConfig.blockWindowMs,
              blockMaxChars: progressConfig.blockMaxChars,
            });
          } else {
            await this.sendProgressEventOutput(channelId, text.trim(), progressConfig.mode);
          }
        }
      }
      return true;
    }

    if (eventType === 'session.cancelled') {
      this.clearProgressBlocksForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        channelId,
        turnId,
      });
      this.clearProgressTranscriptsForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      this.clearProgressModesForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      if (turnId && typeof this.deps.pendingTracker.markCompletedByMessageId === 'function') {
        this.deps.pendingTracker
          .markCompletedByMessageId(projectName, resolvedAgentType, turnId, resolvedInstanceId)
          .catch(() => {});
      } else {
        this.deps.pendingTracker.markCompleted(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
      }
      const msg = text && text.trim().length > 0 ? `: ${text.trim()}` : '';
      await this.deps.messaging.sendToChannel(
        channelId,
        `ℹ️ ${this.formatAgentLabel(resolvedAgentType)} session cancelled${msg}`,
      );
      this.clearStartedTurn({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        turnId,
      });
      return true;
    }

    if (eventType === 'session.idle' || eventType === 'session.final') {
      this.clearProgressBlocksForRoute({
        projectName,
        agentType: resolvedAgentType,
        instanceId: resolvedInstanceId,
        channelId,
        turnId,
      });
      try {
        const trimmed = text && text.trim().length > 0 ? text.trim() : '';
        const effectiveProgressMode = this.resolveProgressModeForTurn({
          projectName,
          agentType: resolvedAgentType,
          instanceId: resolvedInstanceId,
          turnId,
        });
        const transcript =
          this.resolveEventFinalFallbackFromProgressEnabled() &&
          effectiveProgressMode !== 'channel'
            ? this.getProgressTranscript({
                projectName,
                agentType: resolvedAgentType,
                instanceId: resolvedInstanceId,
                turnId,
              })
            : undefined;
        const deliveredText = trimmed.length > 0 ? trimmed : (transcript || '').trim();
        if (deliveredText.length > 0) {
          // Use turnText (all assistant text from the turn) for file path extraction
          // to handle the race condition where displayText doesn't contain file paths
          const turnText = typeof event.turnText === 'string' ? event.turnText.trim() : '';
          const fileSearchText = turnText || deliveredText;
          const projectPath = project.projectPath ? resolve(project.projectPath) : '';
          const filePaths = this.validateFilePaths(extractFilePaths(fileSearchText), projectPath);

          // Strip file paths from the display text to avoid leaking absolute paths
          const displayText = filePaths.length > 0 ? stripFilePaths(deliveredText, filePaths) : deliveredText;

          await this.sendEventOutput(channelId, displayText);

          if (filePaths.length > 0) {
            await this.deps.messaging.sendToChannelWithFiles(channelId, this.buildFileNotice(filePaths), filePaths);
          }
        }

        // Complete after idle output delivery so pending-channel routing remains stable.
        if (turnId && typeof this.deps.pendingTracker.markCompletedByMessageId === 'function') {
          await this.deps.pendingTracker
            .markCompletedByMessageId(projectName, resolvedAgentType, turnId, resolvedInstanceId)
            .catch(() => {});
        } else {
          await this.deps.pendingTracker
            .markCompleted(projectName, resolvedAgentType, resolvedInstanceId)
            .catch(() => {});
        }
        return true;
      } catch (error) {
        if (turnId && typeof this.deps.pendingTracker.markErrorByMessageId === 'function') {
          await this.deps.pendingTracker
            .markErrorByMessageId(projectName, resolvedAgentType, turnId, resolvedInstanceId)
            .catch(() => {});
        } else {
          await this.deps.pendingTracker.markError(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
        }
        throw error;
      } finally {
        this.clearProgressTranscriptsForRoute({
          projectName,
          agentType: resolvedAgentType,
          instanceId: resolvedInstanceId,
          turnId,
        });
        this.clearProgressModesForRoute({
          projectName,
          agentType: resolvedAgentType,
          instanceId: resolvedInstanceId,
          turnId,
        });
        this.clearStartedTurn({
          projectName,
          agentType: resolvedAgentType,
          instanceId: resolvedInstanceId,
          turnId,
        });
      }
    }

    return true;
  }

  private async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    return this.handleAgentEvent(payload, 'opencode-event');
  }
}
