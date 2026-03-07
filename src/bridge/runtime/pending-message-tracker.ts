import type { MessagingClient } from '../../messaging/interface.js';

export type PendingStage = 'received' | 'routed' | 'processing' | 'completed' | 'error' | 'retry';
type PendingTerminalStage = 'completed' | 'error' | 'retry';
type RouteHint = 'reply' | 'thread' | 'memory' | 'attachment';

interface PendingMessageState {
  channelId: string;
  messageId: string;
  stage: PendingStage;
  statusEmoji: string;
  createdAtMs: number;
  updatedAtMs: number;
  promptTail?: string;
  stopTypingIndicator?: () => void;
}

type PendingQueueTarget = 'head' | 'tail';

export interface PendingRuntimeSnapshot {
  pendingDepth: number;
  oldestStage?: PendingStage;
  oldestAgeMs?: number;
  oldestUpdatedAt?: string;
  latestStage?: PendingStage;
  latestAgeMs?: number;
  latestUpdatedAt?: string;
  lastTerminalStage?: PendingTerminalStage;
  lastTerminalAgeMs?: number;
  lastTerminalAt?: string;
}

interface PendingTerminalSnapshot {
  stage: PendingTerminalStage;
  atMs: number;
}

export interface PendingRouteSnapshot {
  channelId?: string;
  pendingDepth: number;
  messageId?: string;
  promptTails: string[];
}

export class PendingMessageTracker {
  private static readonly PROMPT_TAIL_MAX = 240;
  private static readonly MAX_TERMINAL_SNAPSHOTS = 4000;
  private pendingMessageByInstance: Map<string, PendingMessageState[]> = new Map();
  private lastTerminalByInstance: Map<string, PendingTerminalSnapshot> = new Map();
  private operationQueueByKey = new Map<string, Promise<void>>();

  constructor(private messaging: MessagingClient) {}

  private pendingKey(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  private pruneOldest<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  getPendingChannel(projectName: string, agentType: string, instanceId?: string): string | undefined {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    return queue && queue.length > 0 ? queue[0]!.channelId : undefined;
  }

  getPendingDepth(projectName: string, agentType: string, instanceId?: string): number {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.get(key)?.length || 0;
  }

  getPendingPromptTail(projectName: string, agentType: string, instanceId?: string): string | undefined {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    return queue && queue.length > 0 ? queue[0]!.promptTail : undefined;
  }

  getPendingPromptTails(projectName: string, agentType: string, instanceId?: string): string[] {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key) || [];
    return queue
      .map((item) => item.promptTail)
      .filter((tail): tail is string => typeof tail === 'string' && tail.trim().length > 0);
  }

  getPendingMessageId(projectName: string, agentType: string, instanceId?: string): string | undefined {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    return queue && queue.length > 0 ? queue[0]!.messageId : undefined;
  }

  getPendingRouteSnapshot(projectName: string, agentType: string, instanceId?: string): PendingRouteSnapshot {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    if (!queue || queue.length === 0) {
      return {
        pendingDepth: 0,
        promptTails: [],
      };
    }

    return {
      channelId: queue[0]!.channelId,
      pendingDepth: queue.length,
      messageId: queue[0]!.messageId,
      promptTails: queue
        .map((item) => item.promptTail)
        .filter((tail): tail is string => typeof tail === 'string' && tail.trim().length > 0),
    };
  }

  getRuntimeSnapshot(projectName: string, agentType: string, instanceId?: string): PendingRuntimeSnapshot {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key) || [];
    const now = Date.now();
    const oldest = queue[0];
    const latest = queue[queue.length - 1];
    const lastTerminal = this.lastTerminalByInstance.get(key);

    return {
      pendingDepth: queue.length,
      oldestStage: oldest?.stage,
      oldestAgeMs: oldest ? Math.max(0, now - oldest.updatedAtMs) : undefined,
      oldestUpdatedAt: oldest ? new Date(oldest.updatedAtMs).toISOString() : undefined,
      latestStage: latest?.stage,
      latestAgeMs: latest ? Math.max(0, now - latest.updatedAtMs) : undefined,
      latestUpdatedAt: latest ? new Date(latest.updatedAtMs).toISOString() : undefined,
      lastTerminalStage: lastTerminal?.stage,
      lastTerminalAgeMs: lastTerminal ? Math.max(0, now - lastTerminal.atMs) : undefined,
      lastTerminalAt: lastTerminal ? new Date(lastTerminal.atMs).toISOString() : undefined,
    };
  }

  clearPendingForInstance(projectName: string, agentType: string, instanceId?: string): void {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    if (queue) {
      for (const pending of queue) {
        this.stopTypingIndicator(pending);
      }
    }
    this.pendingMessageByInstance.delete(key);
    this.operationQueueByKey.delete(key);
  }

  private enqueueByKey(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operationQueueByKey.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operationQueueByKey.set(key, next);
    return next.finally(() => {
      if (this.operationQueueByKey.get(key) === next) {
        this.operationQueueByKey.delete(key);
      }
    });
  }

  private emojiForStage(stage: PendingStage): string {
    if (this.messaging.platform === 'discord') {
      switch (stage) {
        case 'received':
          return '📥';
        case 'routed':
          return '🚀';
        case 'processing':
          return '⏳';
        case 'completed':
          return '✅';
        case 'error':
          return '❌';
        case 'retry':
          return '⚠️';
      }
    }

    switch (stage) {
      case 'completed':
        return '✅';
      case 'error':
        return '❌';
      case 'retry':
        return '⚠️';
      case 'received':
      case 'routed':
      case 'processing':
        return '⏳';
    }
  }

  private emojiForHint(hint: RouteHint): string | undefined {
    if (this.messaging.platform !== 'discord') return undefined;
    switch (hint) {
      case 'reply':
        return '↩️';
      case 'thread':
        return '🧵';
      case 'memory':
        return '🧠';
      case 'attachment':
        return '📎';
    }
  }

  private resolvePendingState(key: string, target: PendingQueueTarget): PendingMessageState | undefined {
    const queue = this.pendingMessageByInstance.get(key);
    if (!queue || queue.length === 0) return undefined;
    return target === 'head' ? queue[0] : queue[queue.length - 1];
  }

  private removePendingState(key: string, target: PendingQueueTarget): void {
    const queue = this.pendingMessageByInstance.get(key);
    if (!queue || queue.length === 0) return;
    const removed = target === 'head' ? queue.shift() : queue.pop();
    if (removed) {
      this.stopTypingIndicator(removed);
    }
    if (queue.length === 0) {
      this.pendingMessageByInstance.delete(key);
    }
  }

  private removePendingStateByMessageId(key: string, messageId: string): void {
    const queue = this.pendingMessageByInstance.get(key);
    if (!queue || queue.length === 0) return;
    const index = queue.findIndex((pending) => pending.messageId === messageId);
    if (index < 0) return;
    const [removed] = queue.splice(index, 1);
    if (removed) {
      this.stopTypingIndicator(removed);
    }
    if (queue.length === 0) {
      this.pendingMessageByInstance.delete(key);
    }
  }

  private stopTypingIndicator(pending: PendingMessageState): void {
    if (!pending.stopTypingIndicator) return;
    try {
      pending.stopTypingIndicator();
    } catch {
      // Best-effort cleanup.
    }
    pending.stopTypingIndicator = undefined;
  }

  private async ensureTypingIndicator(key: string, pending: PendingMessageState): Promise<void> {
    if (pending.stopTypingIndicator) return;
    if (typeof this.messaging.startTypingIndicator !== 'function') return;
    try {
      const stopTypingIndicator = await this.messaging.startTypingIndicator(pending.channelId);
      const latestQueue = this.pendingMessageByInstance.get(key);
      if (!latestQueue || !latestQueue.includes(pending)) {
        try {
          stopTypingIndicator();
        } catch {
          // Best-effort cleanup.
        }
        return;
      }
      pending.stopTypingIndicator = stopTypingIndicator;
    } catch {
      // Non-critical.
    }
  }

  private async transitionByKey(
    key: string,
    stage: PendingStage,
    removeAfter: boolean = false,
    target: PendingQueueTarget = 'tail',
  ): Promise<void> {
    await this.enqueueByKey(key, async () => {
      const pending = this.resolvePendingState(key, target);
      if (!pending) return;

      const nextEmoji = this.emojiForStage(stage);
      if (pending.statusEmoji !== nextEmoji) {
        await this.messaging.replaceOwnReactionOnMessage(
          pending.channelId,
          pending.messageId,
          pending.statusEmoji,
          nextEmoji,
        );
        pending.statusEmoji = nextEmoji;
      }

      pending.stage = stage;
      pending.updatedAtMs = Date.now();
      if (stage === 'processing') {
        await this.ensureTypingIndicator(key, pending);
      }

      if (removeAfter) {
        if (stage === 'completed' || stage === 'error' || stage === 'retry') {
          this.lastTerminalByInstance.set(key, { stage, atMs: pending.updatedAtMs });
          this.pruneOldest(this.lastTerminalByInstance, PendingMessageTracker.MAX_TERMINAL_SNAPSHOTS);
        }
        this.removePendingState(key, target);
      }
    });
  }

  private async transitionByMessageId(
    key: string,
    messageId: string,
    stage: PendingStage,
    removeAfter: boolean = false,
  ): Promise<void> {
    await this.enqueueByKey(key, async () => {
      const queue = this.pendingMessageByInstance.get(key);
      if (!queue || queue.length === 0) return;
      const pending = queue.find((candidate) => candidate.messageId === messageId);
      if (!pending) return;

      const nextEmoji = this.emojiForStage(stage);
      if (pending.statusEmoji !== nextEmoji) {
        await this.messaging.replaceOwnReactionOnMessage(
          pending.channelId,
          pending.messageId,
          pending.statusEmoji,
          nextEmoji,
        );
        pending.statusEmoji = nextEmoji;
      }

      pending.stage = stage;
      pending.updatedAtMs = Date.now();
      if (stage === 'processing') {
        await this.ensureTypingIndicator(key, pending);
      }

      if (removeAfter) {
        if (stage === 'completed' || stage === 'error' || stage === 'retry') {
          this.lastTerminalByInstance.set(key, { stage, atMs: pending.updatedAtMs });
          this.pruneOldest(this.lastTerminalByInstance, PendingMessageTracker.MAX_TERMINAL_SNAPSHOTS);
        }
        this.removePendingStateByMessageId(key, messageId);
      }
    });
  }

  private async addHintByKey(key: string, hint: RouteHint, target: PendingQueueTarget = 'tail'): Promise<void> {
    await this.enqueueByKey(key, async () => {
      const pending = this.resolvePendingState(key, target);
      if (!pending) return;
      const emoji = this.emojiForHint(hint);
      if (!emoji) return;
      await this.messaging.addReactionToMessage(pending.channelId, pending.messageId, emoji);
    });
  }

  async markPending(
    projectName: string,
    agentType: string,
    channelId: string,
    messageId: string,
    instanceId?: string,
    prompt?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.enqueueByKey(key, async () => {
      const statusEmoji = this.emojiForStage('received');
      const now = Date.now();
      const queue = this.pendingMessageByInstance.get(key) || [];
      const existing = queue.find((candidate) => candidate.messageId === messageId);
      if (existing) {
        existing.updatedAtMs = now;
        existing.channelId = channelId;
        existing.promptTail = this.buildPromptTail(prompt);
        return;
      }
      const pendingState: PendingMessageState = {
        channelId,
        messageId,
        stage: 'received',
        statusEmoji,
        createdAtMs: now,
        updatedAtMs: now,
        promptTail: this.buildPromptTail(prompt),
      };
      queue.push(pendingState);
      this.pendingMessageByInstance.set(key, queue);
      await this.messaging.addReactionToMessage(channelId, messageId, statusEmoji);
    });
  }

  private buildPromptTail(prompt?: string): string | undefined {
    if (typeof prompt !== 'string') return undefined;
    const compact = prompt.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return undefined;
    return compact.slice(Math.max(0, compact.length - PendingMessageTracker.PROMPT_TAIL_MAX));
  }

  async markRouteResolved(
    projectName: string,
    agentType: string,
    instanceId?: string,
    hint?: Exclude<RouteHint, 'attachment'>,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    if (hint) {
      await this.addHintByKey(key, hint);
    }
    await this.transitionByKey(key, 'routed');
  }

  async markDispatching(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByKey(key, 'processing');
  }

  async markDispatchingByMessageId(
    projectName: string,
    agentType: string,
    messageId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByMessageId(key, messageId, 'processing');
  }

  async markHasAttachments(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.addHintByKey(key, 'attachment');
  }

  async markRetry(
    projectName: string,
    agentType: string,
    instanceId?: string,
    target: PendingQueueTarget = 'head',
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByKey(key, 'retry', true, target);
  }

  async markCompleted(
    projectName: string,
    agentType: string,
    instanceId?: string,
    target: PendingQueueTarget = 'head',
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByKey(key, 'completed', true, target);
  }

  async markCompletedByMessageId(
    projectName: string,
    agentType: string,
    messageId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByMessageId(key, messageId, 'completed', true);
  }

  async markError(
    projectName: string,
    agentType: string,
    instanceId?: string,
    target: PendingQueueTarget = 'head',
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByKey(key, 'error', true, target);
  }

  async markErrorByMessageId(
    projectName: string,
    agentType: string,
    messageId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByMessageId(key, messageId, 'error', true);
  }
}
