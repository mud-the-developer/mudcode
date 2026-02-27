import { describe, expect, it, vi } from 'vitest';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';

describe('PendingMessageTracker', () => {
  it('uses richer Discord lifecycle reactions', async () => {
    const messaging = {
      platform: 'discord' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'ch-1', 'msg-1', 'codex');
    await tracker.markRouteResolved('demo', 'codex', 'codex', 'memory');
    await tracker.markDispatching('demo', 'codex', 'codex');
    await tracker.markCompleted('demo', 'codex', 'codex');

    expect(messaging.addReactionToMessage).toHaveBeenNthCalledWith(1, 'ch-1', 'msg-1', '📥');
    expect(messaging.addReactionToMessage).toHaveBeenNthCalledWith(2, 'ch-1', 'msg-1', '🧠');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenNthCalledWith(1, 'ch-1', 'msg-1', '📥', '🚀');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenNthCalledWith(2, 'ch-1', 'msg-1', '🚀', '⏳');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenNthCalledWith(3, 'ch-1', 'msg-1', '⏳', '✅');
  });

  it('keeps compact lifecycle reactions on Slack', async () => {
    const messaging = {
      platform: 'slack' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'ch-1', 'msg-1', 'codex');
    await tracker.markRouteResolved('demo', 'codex', 'codex', 'reply');
    await tracker.markDispatching('demo', 'codex', 'codex');
    await tracker.markRetry('demo', 'codex', 'codex');

    expect(messaging.addReactionToMessage).toHaveBeenCalledTimes(1);
    expect(messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledTimes(1);
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '⚠️');
  });

  it('tracks pending requests in FIFO order per instance', async () => {
    const messaging = {
      platform: 'discord' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'thread-a', 'msg-a', 'codex');
    await tracker.markPending('demo', 'codex', 'thread-b', 'msg-b', 'codex');
    await tracker.markRouteResolved('demo', 'codex', 'codex', 'thread');

    // Route hints/lifecycle updates should target the newest incoming request.
    expect(messaging.addReactionToMessage).toHaveBeenCalledWith('thread-b', 'msg-b', '🧵');

    // Output routing should still follow the oldest unresolved request first.
    expect(tracker.getPendingChannel('demo', 'codex', 'codex')).toBe('thread-a');

    await tracker.markCompleted('demo', 'codex', 'codex');
    expect(tracker.getPendingChannel('demo', 'codex', 'codex')).toBe('thread-b');
  });

  it('stores a compact prompt tail for pending output de-echo', async () => {
    const messaging = {
      platform: 'discord' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);
    const prompt = 'prefix ' + 'x'.repeat(300);

    await tracker.markPending('demo', 'codex', 'thread-a', 'msg-a', 'codex', prompt);

    const stored = tracker.getPendingPromptTail('demo', 'codex', 'codex');
    expect(stored).toBeDefined();
    expect(stored!.length).toBeLessThanOrEqual(240);
    expect(prompt.endsWith(stored!)).toBe(true);

    const tails = tracker.getPendingPromptTails('demo', 'codex', 'codex');
    expect(tails).toEqual([stored]);
  });

  it('exposes runtime snapshot for in-flight and terminal states', async () => {
    const messaging = {
      platform: 'discord' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'ch-1', 'msg-1', 'codex');
    await tracker.markRouteResolved('demo', 'codex', 'codex');
    await tracker.markDispatching('demo', 'codex', 'codex');

    const active = tracker.getRuntimeSnapshot('demo', 'codex', 'codex');
    expect(active.pendingDepth).toBe(1);
    expect(active.oldestStage).toBe('processing');
    expect(active.latestStage).toBe('processing');

    await tracker.markCompleted('demo', 'codex', 'codex');

    const terminal = tracker.getRuntimeSnapshot('demo', 'codex', 'codex');
    expect(terminal.pendingDepth).toBe(0);
    expect(terminal.lastTerminalStage).toBe('completed');
  });

  it('clears all pending requests for an instance', async () => {
    const messaging = {
      platform: 'discord' as const,
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'thread-a', 'msg-a', 'codex');
    await tracker.markPending('demo', 'codex', 'thread-b', 'msg-b', 'codex');

    expect(tracker.getPendingDepth('demo', 'codex', 'codex')).toBe(2);

    tracker.clearPendingForInstance('demo', 'codex', 'codex');

    expect(tracker.getPendingDepth('demo', 'codex', 'codex')).toBe(0);
    expect(tracker.getPendingChannel('demo', 'codex', 'codex')).toBeUndefined();
  });

  it('starts and stops Discord typing indicator through lifecycle', async () => {
    const stopTyping = vi.fn();
    const messaging = {
      platform: 'discord' as const,
      startTypingIndicator: vi.fn().mockResolvedValue(stopTyping),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'ch-typing', 'msg-typing', 'codex');
    expect(messaging.startTypingIndicator).toHaveBeenCalledWith('ch-typing');
    expect(stopTyping).not.toHaveBeenCalled();

    await tracker.markCompleted('demo', 'codex', 'codex');
    expect(stopTyping).toHaveBeenCalledTimes(1);
  });

  it('stops typing indicator when a pending request transitions to error', async () => {
    const stopTyping = vi.fn();
    const messaging = {
      platform: 'discord' as const,
      startTypingIndicator: vi.fn().mockResolvedValue(stopTyping),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'ch-typing', 'msg-typing', 'codex');
    await tracker.markError('demo', 'codex', 'codex');

    expect(stopTyping).toHaveBeenCalledTimes(1);
  });

  it('stops all active typing indicators when pending queue is cleared', async () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const messaging = {
      platform: 'discord' as const,
      startTypingIndicator: vi
        .fn()
        .mockResolvedValueOnce(stopA)
        .mockResolvedValueOnce(stopB),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    } as any;
    const tracker = new PendingMessageTracker(messaging);

    await tracker.markPending('demo', 'codex', 'thread-a', 'msg-a', 'codex');
    await tracker.markPending('demo', 'codex', 'thread-b', 'msg-b', 'codex');

    tracker.clearPendingForInstance('demo', 'codex', 'codex');

    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });

  it('retries typing keepalive instead of sending delayed stuck-processing text', async () => {
    vi.useFakeTimers();
    process.env.AGENT_DISCORD_PENDING_ALERT_MS = '5000';
    try {
      const stopTyping = vi.fn();
      const messaging = {
        platform: 'discord' as const,
        startTypingIndicator: vi.fn().mockRejectedValueOnce(new Error('transient failure')).mockResolvedValueOnce(stopTyping),
        sendToChannel: vi.fn().mockResolvedValue(undefined),
        addReactionToMessage: vi.fn().mockResolvedValue(undefined),
        replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
      } as any;
      const tracker = new PendingMessageTracker(messaging);

      await tracker.markPending('demo', 'codex', 'ch-1', 'msg-1', 'codex');
      expect(messaging.startTypingIndicator).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();

      expect(messaging.startTypingIndicator).toHaveBeenCalledTimes(2);
      expect(messaging.sendToChannel).not.toHaveBeenCalled();
      expect(stopTyping).not.toHaveBeenCalled();

      await tracker.markCompleted('demo', 'codex', 'codex');
      expect(stopTyping).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.AGENT_DISCORD_PENDING_ALERT_MS;
      vi.useRealTimers();
    }
  });
});
