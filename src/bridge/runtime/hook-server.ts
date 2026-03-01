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
        const lifecycle = this.getEventLifecycleSnapshot(project.projectName, instance.instanceId);
        instances.push({
          projectName: project.projectName,
          instanceId: instance.instanceId,
          agentType: instance.agentType,
          ...this.getRuntimeSnapshotForInstance(project.projectName, instance.agentType, instance.instanceId),
          ...(ignored || {}),
          ...(lifecycle || {}),
        });
      }
    }
    this.pruneIgnoredEvents(activeInstanceKeys);
    this.pruneEventLifecycle(activeInstanceKeys);

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
      return true;
    }

    if (eventType === 'session.start') {
      return true;
    }

    if (eventType === 'session.progress') {
      return true;
    }

    if (eventType === 'session.cancelled') {
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
      return true;
    }

    if (eventType === 'session.idle' || eventType === 'session.final') {
      try {
        if (text && text.trim().length > 0) {
          const trimmed = text.trim();
          // Use turnText (all assistant text from the turn) for file path extraction
          // to handle the race condition where displayText doesn't contain file paths
          const turnText = typeof event.turnText === 'string' ? event.turnText.trim() : '';
          const fileSearchText = turnText || trimmed;
          const projectPath = project.projectPath ? resolve(project.projectPath) : '';
          const filePaths = this.validateFilePaths(extractFilePaths(fileSearchText), projectPath);

          // Strip file paths from the display text to avoid leaking absolute paths
          const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;

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
      }
    }

    return true;
  }

  private async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    return this.handleAgentEvent(payload, 'opencode-event');
  }
}
