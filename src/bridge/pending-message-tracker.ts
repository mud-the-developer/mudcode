import type { MessagingClient } from '../messaging/interface.js';

type PendingStage = 'received' | 'routed' | 'processing' | 'completed' | 'error' | 'retry';
type RouteHint = 'reply' | 'thread' | 'memory' | 'attachment';

interface PendingMessageState {
  channelId: string;
  messageId: string;
  statusEmoji: string;
  promptTail?: string;
  stopTypingIndicator?: () => void;
}

type PendingQueueTarget = 'head' | 'tail';

export class PendingMessageTracker {
  private static readonly PROMPT_TAIL_MAX = 240;
  private pendingMessageByInstance: Map<string, PendingMessageState[]> = new Map();

  constructor(private messaging: MessagingClient) {}

  private pendingKey(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
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

  clearPendingForInstance(projectName: string, agentType: string, instanceId?: string): void {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const queue = this.pendingMessageByInstance.get(key);
    if (queue) {
      for (const pending of queue) {
        this.stopTypingIndicator(pending);
      }
    }
    this.pendingMessageByInstance.delete(key);
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

  private stopTypingIndicator(pending: PendingMessageState): void {
    if (!pending.stopTypingIndicator) return;
    try {
      pending.stopTypingIndicator();
    } catch {
      // Best-effort cleanup.
    }
    pending.stopTypingIndicator = undefined;
  }

  private async transitionByKey(
    key: string,
    stage: PendingStage,
    removeAfter: boolean = false,
    target: PendingQueueTarget = 'tail',
  ): Promise<void> {
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

    if (removeAfter) {
      this.removePendingState(key, target);
    }
  }

  private async addHintByKey(key: string, hint: RouteHint, target: PendingQueueTarget = 'tail'): Promise<void> {
    const pending = this.resolvePendingState(key, target);
    if (!pending) return;
    const emoji = this.emojiForHint(hint);
    if (!emoji) return;
    await this.messaging.addReactionToMessage(pending.channelId, pending.messageId, emoji);
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
    const statusEmoji = this.emojiForStage('received');
    let stopTypingIndicator: (() => void) | undefined;
    if (typeof this.messaging.startTypingIndicator === 'function') {
      try {
        stopTypingIndicator = await this.messaging.startTypingIndicator(channelId);
      } catch {
        // Non-critical.
      }
    }
    const queue = this.pendingMessageByInstance.get(key) || [];
    queue.push({ channelId, messageId, statusEmoji, promptTail: this.buildPromptTail(prompt), stopTypingIndicator });
    this.pendingMessageByInstance.set(key, queue);
    await this.messaging.addReactionToMessage(channelId, messageId, statusEmoji);
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

  async markError(
    projectName: string,
    agentType: string,
    instanceId?: string,
    target: PendingQueueTarget = 'head',
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    await this.transitionByKey(key, 'error', true, target);
  }
}
