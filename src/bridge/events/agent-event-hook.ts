import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type AgentEventType =
  | 'session.start'
  | 'session.progress'
  | 'session.final'
  | 'session.idle'
  | 'session.error'
  | 'session.cancelled';

export interface AgentEventHookPayload {
  projectName: string;
  agentType: string;
  instanceId?: string;
  eventId?: string;
  turnId?: string;
  seq?: number;
  type: AgentEventType;
  text?: string;
  progressMode?: 'off' | 'thread' | 'channel';
  progressBlockStreaming?: boolean;
  progressBlockWindowMs?: number;
  progressBlockMaxChars?: number;
  channelId?: string;
  source?: string;
}

export interface AgentEventHookClient {
  readonly enabled: boolean;
  post(payload: AgentEventHookPayload): Promise<boolean>;
  emitCodexStart(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
  }): Promise<boolean>;
  emitCodexFinal(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text?: string;
  }): Promise<boolean>;
  emitCodexProgress(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text?: string;
    progressMode?: 'off' | 'thread' | 'channel';
    progressBlockStreaming?: boolean;
    progressBlockWindowMs?: number;
    progressBlockMaxChars?: number;
  }): Promise<boolean>;
  emitCodexError(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text: string;
  }): Promise<boolean>;
}

type OutboxEntry = { payload: AgentEventHookPayload; attempt: number; dueAtMs: number };

export class LocalAgentEventHookClient implements AgentEventHookClient {
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly outboxMax: number;
  private readonly outboxPersistPath?: string;
  private readonly outboxPersistFlushMs: number;
  private readonly outboxPersistRetentionMs: number;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistDirty = false;
  private outbox: OutboxEntry[] = [];
  private eventSequence = 0;
  private turnSequenceByKey = new Map<string, number>();

  constructor(params?: { port?: number; enabled?: boolean; timeoutMs?: number }) {
    this.enabled = this.resolveEnabled(params?.enabled);
    const port = this.resolvePort(params?.port);
    this.endpoint = `http://127.0.0.1:${port}/agent-event`;
    this.timeoutMs = this.resolveTimeoutMs(params?.timeoutMs);
    this.retryMax = this.resolveRetryMax();
    this.retryBaseMs = this.resolveRetryBaseMs();
    this.retryMaxMs = this.resolveRetryMaxMs();
    this.outboxMax = this.resolveOutboxMax();
    this.outboxPersistPath = this.resolveOutboxPersistPath();
    this.outboxPersistFlushMs = this.resolveOutboxPersistFlushMs();
    this.outboxPersistRetentionMs = this.resolveOutboxPersistRetentionMs();
    this.loadPersistedOutbox();
    if (this.outbox.length > 0) {
      this.scheduleDrain(0);
    }
  }

  async post(payload: AgentEventHookPayload): Promise<boolean> {
    if (!this.enabled) return false;
    if (!payload.projectName || !payload.agentType || !payload.type) return false;

    const normalized = this.normalizePayload(payload);
    return this.postOnce(normalized);
  }

  private async postOnce(payload: AgentEventHookPayload): Promise<boolean> {
    if (!this.enabled) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  emitCodexStart(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
  }): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    const payload = this.normalizePayload({
      projectName: params.projectName,
      agentType: 'codex',
      instanceId: params.instanceId,
      turnId: params.turnId,
      type: 'session.start',
      channelId: params.channelId,
      source: 'codex-poc',
    });
    return Promise.resolve(this.enqueueWithRetry(payload));
  }

  emitCodexFinal(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text?: string;
  }): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    const payload = this.normalizePayload({
      projectName: params.projectName,
      agentType: 'codex',
      instanceId: params.instanceId,
      turnId: params.turnId,
      type: 'session.final',
      text: params.text,
      channelId: params.channelId,
      source: 'codex-poc',
    });
    return Promise.resolve(this.enqueueWithRetry(payload));
  }

  emitCodexProgress(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text?: string;
    progressMode?: 'off' | 'thread' | 'channel';
    progressBlockStreaming?: boolean;
    progressBlockWindowMs?: number;
    progressBlockMaxChars?: number;
  }): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    const payload = this.normalizePayload({
      projectName: params.projectName,
      agentType: 'codex',
      instanceId: params.instanceId,
      turnId: params.turnId,
      type: 'session.progress',
      text: params.text,
      progressMode: params.progressMode,
      progressBlockStreaming: params.progressBlockStreaming,
      progressBlockWindowMs: params.progressBlockWindowMs,
      progressBlockMaxChars: params.progressBlockMaxChars,
      channelId: params.channelId,
      source: 'codex-poc',
    });
    return Promise.resolve(this.enqueueWithRetry(payload));
  }

  emitCodexError(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text: string;
  }): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    const payload = this.normalizePayload({
      projectName: params.projectName,
      agentType: 'codex',
      instanceId: params.instanceId,
      turnId: params.turnId,
      type: 'session.error',
      text: params.text,
      channelId: params.channelId,
      source: 'codex-poc',
    });
    return Promise.resolve(this.enqueueWithRetry(payload));
  }

  private normalizePayload(payload: AgentEventHookPayload): AgentEventHookPayload {
    const withSeq = this.attachSequence(payload);
    if (withSeq.eventId && withSeq.eventId.trim().length > 0) return withSeq;
    return {
      ...withSeq,
      eventId: this.generateEventId(withSeq),
    };
  }

  private generateEventId(payload: AgentEventHookPayload): string {
    const turnPart = payload.turnId && payload.turnId.trim().length > 0 ? payload.turnId.trim() : '';
    const agentPart = payload.instanceId || payload.agentType;
    if (turnPart && typeof payload.seq === 'number' && Number.isFinite(payload.seq)) {
      return `${payload.projectName}:${agentPart}:${payload.type}:${turnPart}:seq-${payload.seq}`;
    }
    if (turnPart) {
      return `${payload.projectName}:${agentPart}:${payload.type}:${turnPart}`;
    }
    this.eventSequence += 1;
    return `${payload.projectName}:${agentPart}:${payload.type}:seq-${Date.now()}-${this.eventSequence}`;
  }

  private attachSequence(payload: AgentEventHookPayload): AgentEventHookPayload {
    if (typeof payload.seq === 'number' && Number.isFinite(payload.seq) && payload.seq >= 0) {
      return payload;
    }
    const turnId = payload.turnId?.trim();
    if (!turnId) return payload;
    const key = `${payload.projectName}:${payload.instanceId || payload.agentType}:${turnId}`;
    const next = (this.turnSequenceByKey.get(key) || 0) + 1;
    this.turnSequenceByKey.delete(key);
    this.turnSequenceByKey.set(key, next);
    this.pruneTurnSequenceMap();
    return {
      ...payload,
      seq: next,
    };
  }

  private pruneTurnSequenceMap(): void {
    const maxEntries = 50_000;
    while (this.turnSequenceByKey.size > maxEntries) {
      const oldest = this.turnSequenceByKey.keys().next();
      if (oldest.done) return;
      this.turnSequenceByKey.delete(oldest.value);
    }
  }

  private enqueueWithRetry(payload: AgentEventHookPayload): boolean {
    if (!this.enabled) return false;
    if (this.coalesceQueuedProgress(payload)) {
      this.scheduleDrain(0);
      return true;
    }
    this.enforceOutboxCapacity();
    this.outbox.push({
      payload,
      attempt: 0,
      dueAtMs: Date.now(),
    });
    this.markOutboxDirty();
    this.scheduleDrain(0);
    return true;
  }

  private resolveOutboxMax(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 20_000) {
      return Math.trunc(fromEnv);
    }
    return 2000;
  }

  private progressQueueKey(payload: AgentEventHookPayload): string {
    return [
      payload.projectName,
      payload.agentType,
      payload.instanceId || 'na',
      payload.turnId || 'na',
      payload.channelId || 'na',
    ].join(':');
  }

  private coalesceQueuedProgress(payload: AgentEventHookPayload): boolean {
    if (payload.type !== 'session.progress') return false;
    const key = this.progressQueueKey(payload);
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      const queued = this.outbox[i];
      if (!queued) continue;
      if (queued.attempt > 0) continue;
      if (queued.payload.type !== 'session.progress') continue;
      if (this.progressQueueKey(queued.payload) !== key) continue;
      this.outbox[i] = {
        payload,
        attempt: 0,
        dueAtMs: Math.min(queued.dueAtMs, Date.now()),
      };
      this.markOutboxDirty();
      return true;
    }
    return false;
  }

  private enforceOutboxCapacity(): void {
    if (this.outboxMax <= 0) return;
    if (this.outbox.length < this.outboxMax) return;

    let dropIndex = this.outbox.findIndex((entry) => entry.payload.type === 'session.progress');
    if (dropIndex < 0) {
      dropIndex = 0;
    }
    this.outbox.splice(dropIndex, 1);
    this.markOutboxDirty();
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer) return;
    const safeDelay = Math.max(0, Math.trunc(delayMs));
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      void this.drainOutbox();
    }, safeDelay);
    this.drainTimer.unref?.();
  }

  private computeRetryDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = this.retryBaseMs * (2 ** exponent);
    return Math.min(this.retryMaxMs, raw);
  }

  private async drainOutbox(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        const now = Date.now();
        const head = this.outbox[0]!;
        if (head.dueAtMs > now) {
          this.scheduleDrain(head.dueAtMs - now);
          return;
        }

        this.outbox.shift();
        this.markOutboxDirty();
        const ok = await this.postOnce(head.payload);
        if (ok) continue;

        if (head.attempt >= this.retryMax) {
          continue;
        }
        const nextAttempt = head.attempt + 1;
        const nextDelay = this.computeRetryDelayMs(nextAttempt);
        this.enforceOutboxCapacity();
        this.outbox.push({
          payload: head.payload,
          attempt: nextAttempt,
          dueAtMs: Date.now() + nextDelay,
        });
        this.markOutboxDirty();
      }
    } finally {
      this.draining = false;
      if (this.outbox.length > 0 && !this.drainTimer) {
        this.scheduleDrain(0);
      }
    }
  }

  private isValidAgentEventType(value: unknown): value is AgentEventType {
    return (
      value === 'session.start' ||
      value === 'session.progress' ||
      value === 'session.final' ||
      value === 'session.idle' ||
      value === 'session.error' ||
      value === 'session.cancelled'
    );
  }

  private normalizePersistedPayload(raw: unknown): AgentEventHookPayload | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const candidate = raw as Record<string, unknown>;
    const projectName =
      typeof candidate.projectName === 'string' && candidate.projectName.trim().length > 0
        ? candidate.projectName.trim()
        : '';
    const agentType =
      typeof candidate.agentType === 'string' && candidate.agentType.trim().length > 0
        ? candidate.agentType.trim()
        : '';
    const type = candidate.type;
    if (!projectName || !agentType || !this.isValidAgentEventType(type)) return undefined;

    const payload: AgentEventHookPayload = {
      projectName,
      agentType,
      type,
    };
    if (typeof candidate.instanceId === 'string' && candidate.instanceId.trim().length > 0) {
      payload.instanceId = candidate.instanceId.trim();
    }
    if (typeof candidate.eventId === 'string' && candidate.eventId.trim().length > 0) {
      payload.eventId = candidate.eventId.trim();
    }
    if (typeof candidate.turnId === 'string' && candidate.turnId.trim().length > 0) {
      payload.turnId = candidate.turnId.trim();
    }
    if (typeof candidate.seq === 'number' && Number.isFinite(candidate.seq) && candidate.seq >= 0) {
      payload.seq = Math.trunc(candidate.seq);
    }
    if (typeof candidate.text === 'string') {
      payload.text = candidate.text;
    }
    if (
      candidate.progressMode === 'off' ||
      candidate.progressMode === 'thread' ||
      candidate.progressMode === 'channel'
    ) {
      payload.progressMode = candidate.progressMode;
    }
    if (typeof candidate.progressBlockStreaming === 'boolean') {
      payload.progressBlockStreaming = candidate.progressBlockStreaming;
    }
    if (
      typeof candidate.progressBlockWindowMs === 'number' &&
      Number.isFinite(candidate.progressBlockWindowMs)
    ) {
      payload.progressBlockWindowMs = Math.trunc(candidate.progressBlockWindowMs);
    }
    if (
      typeof candidate.progressBlockMaxChars === 'number' &&
      Number.isFinite(candidate.progressBlockMaxChars)
    ) {
      payload.progressBlockMaxChars = Math.trunc(candidate.progressBlockMaxChars);
    }
    if (typeof candidate.channelId === 'string' && candidate.channelId.trim().length > 0) {
      payload.channelId = candidate.channelId.trim();
    }
    if (typeof candidate.source === 'string' && candidate.source.trim().length > 0) {
      payload.source = candidate.source.trim();
    }
    return payload;
  }

  private loadPersistedOutbox(): void {
    if (!this.outboxPersistPath || !existsSync(this.outboxPersistPath)) return;
    try {
      const raw = readFileSync(this.outboxPersistPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const persisted = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { outbox?: unknown[] })?.outbox)
          ? ((parsed as { outbox: unknown[] }).outbox || [])
          : [];
      const now = Date.now();
      const next: OutboxEntry[] = [];
      for (const item of persisted) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const payload = this.normalizePersistedPayload(record.payload);
        if (!payload) continue;
        const attemptRaw = Number(record.attempt);
        const attempt =
          Number.isFinite(attemptRaw) && attemptRaw >= 0 && attemptRaw <= this.retryMax
            ? Math.trunc(attemptRaw)
            : 0;
        const dueAtRaw = Number(record.dueAtMs);
        const dueAtMs = Number.isFinite(dueAtRaw) ? Math.trunc(dueAtRaw) : now;
        const updatedAtRaw = Number(record.updatedAtMs ?? dueAtMs);
        const updatedAtMs = Number.isFinite(updatedAtRaw) ? Math.trunc(updatedAtRaw) : dueAtMs;
        if (now - updatedAtMs > this.outboxPersistRetentionMs) continue;
        next.push({
          payload,
          attempt,
          dueAtMs: dueAtMs < now ? now : dueAtMs,
        });
      }
      next.sort((a, b) => a.dueAtMs - b.dueAtMs);
      this.outbox = next.slice(Math.max(0, next.length - this.outboxMax));
    } catch {
      // best effort restore
    }
  }

  private markOutboxDirty(): void {
    if (!this.outboxPersistPath) return;
    this.persistDirty = true;
    if (this.outboxPersistFlushMs <= 0) {
      this.flushPersistedOutbox();
      return;
    }
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flushPersistedOutbox();
    }, this.outboxPersistFlushMs);
    this.persistTimer.unref?.();
  }

  private flushPersistedOutbox(): void {
    if (!this.outboxPersistPath || !this.persistDirty) return;
    this.persistDirty = false;
    try {
      mkdirSync(dirname(this.outboxPersistPath), { recursive: true });
      if (this.outbox.length === 0) {
        rmSync(this.outboxPersistPath, { force: true });
        return;
      }
      const now = Date.now();
      const serialized = {
        updatedAtMs: now,
        outbox: this.outbox.map((entry) => ({
          payload: entry.payload,
          attempt: entry.attempt,
          dueAtMs: entry.dueAtMs,
          updatedAtMs: now,
        })),
      };
      const tempPath = `${this.outboxPersistPath}.tmp-${process.pid}-${now}`;
      writeFileSync(tempPath, JSON.stringify(serialized));
      renameSync(tempPath, this.outboxPersistPath);
    } catch {
      this.persistDirty = true;
    }
  }

  private resolveOutboxPersistPath(): string | undefined {
    const raw = process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.toLowerCase() === 'off' || trimmed === '0' || trimmed.toLowerCase() === 'false') {
        return undefined;
      }
      if (trimmed.length > 0) return trimmed;
    }
    return join(homedir(), '.mudcode', 'runtime', 'agent-event-hook-outbox.json');
  }

  private resolveOutboxPersistFlushMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 10_000) {
      return Math.trunc(fromEnv);
    }
    return 200;
  }

  private resolveOutboxPersistRetentionMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_RETENTION_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1000 && fromEnv <= 7 * 24 * 60 * 60 * 1000) {
      return Math.trunc(fromEnv);
    }
    return 24 * 60 * 60 * 1000;
  }

  private resolvePort(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1 && configured <= 65535) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.HOOK_SERVER_PORT || process.env.AGENT_DISCORD_PORT || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
      return Math.trunc(fromEnv);
    }
    return 18470;
  }

  private resolveTimeoutMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 200 && configured <= 20000) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_TIMEOUT_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 200 && fromEnv <= 20000) {
      return Math.trunc(fromEnv);
    }
    return 1500;
  }

  private resolveRetryMax(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 10) {
      return Math.trunc(fromEnv);
    }
    return 3;
  }

  private resolveRetryBaseMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 50 && fromEnv <= 5000) {
      return Math.trunc(fromEnv);
    }
    return 250;
  }

  private resolveRetryMaxMs(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 100 && fromEnv <= 30000) {
      return Math.trunc(fromEnv);
    }
    return 5000;
  }

  private resolveEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;
    const raw = process.env.AGENT_DISCORD_CODEX_EVENT_POC;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }
}
