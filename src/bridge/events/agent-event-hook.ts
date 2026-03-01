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

export class LocalAgentEventHookClient implements AgentEventHookClient {
  readonly enabled: boolean;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly retryMax: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private draining = false;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private outbox: Array<{ payload: AgentEventHookPayload; attempt: number; dueAtMs: number }> = [];
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
    return this.post({
      projectName: params.projectName,
      agentType: 'codex',
      instanceId: params.instanceId,
      turnId: params.turnId,
      type: 'session.final',
      text: params.text,
      channelId: params.channelId,
      source: 'codex-poc',
    });
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
    return this.post({
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
    this.outbox.push({
      payload,
      attempt: 0,
      dueAtMs: Date.now(),
    });
    this.scheduleDrain(0);
    return true;
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
        const ok = await this.postOnce(head.payload);
        if (ok) continue;

        if (head.attempt >= this.retryMax) {
          continue;
        }
        const nextAttempt = head.attempt + 1;
        const nextDelay = this.computeRetryDelayMs(nextAttempt);
        this.outbox.push({
          payload: head.payload,
          attempt: nextAttempt,
          dueAtMs: Date.now() + nextDelay,
        });
      }
    } finally {
      this.draining = false;
      if (this.outbox.length > 0 && !this.drainTimer) {
        this.scheduleDrain(0);
      }
    }
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
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return false;
  }
}
