import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeCapturePoller } from '../../src/bridge/capture-poller.js';

type ReplayCase = {
  name: string;
  projectName: string;
  tmuxSession: string;
  agentType: string;
  instanceId: string;
  tmuxWindow: string;
  channelId: string;
  pendingChannel?: string;
  pendingDepth?: number;
  promptTails?: string[];
  captures: string[];
  expectedMessages: string[];
  expectedChannel: string;
  expectedCompletedCalls?: number;
  intervalMs?: number;
};

function loadReplayCases(): ReplayCase[] {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(baseDir, '../fixtures/capture-replay/codex-capture-replay.json');
  const raw = readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ReplayCase[];
}

function createStateManager(input: ReplayCase) {
  return {
    listProjects: vi.fn().mockReturnValue([
      {
        projectName: input.projectName,
        projectPath: '/tmp/demo',
        tmuxSession: input.tmuxSession,
        instances: {
          [input.instanceId]: {
            instanceId: input.instanceId,
            agentType: input.agentType,
            tmuxWindow: input.tmuxWindow,
            channelId: input.channelId,
            eventHook: false,
          },
        },
      },
    ]),
  } as any;
}

function createTmux(captures: string[]) {
  const queue = [...captures];
  return {
    capturePaneFromWindow: vi.fn().mockImplementation(() => queue.shift() ?? queue[queue.length - 1] ?? ''),
  } as any;
}

describe('BridgeCapturePoller replay fixtures', () => {
  const replayCases = loadReplayCases();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const replay of replayCases) {
    it(replay.name, async () => {
      const intervalMs = replay.intervalMs ?? 300;
      const stateManager = createStateManager(replay);
      const messaging = {
        platform: 'discord' as const,
        sendToChannel: vi.fn().mockResolvedValue(undefined),
      } as any;
      const tmux = createTmux(replay.captures);
      const pendingTracker = {
        getPendingChannel: vi.fn().mockReturnValue(replay.pendingChannel),
        getPendingDepth: vi.fn().mockReturnValue(replay.pendingDepth ?? (replay.pendingChannel ? 1 : 0)),
        getPendingPromptTails: vi.fn().mockReturnValue(replay.promptTails || []),
        getPendingPromptTail: vi.fn().mockReturnValue((replay.promptTails || [])[0]),
        markCompleted: vi.fn().mockResolvedValue(undefined),
      } as any;

      const poller = new BridgeCapturePoller({
        messaging,
        tmux,
        stateManager,
        pendingTracker,
        intervalMs,
      });

      poller.start();
      await Promise.resolve();

      for (let i = 1; i < replay.captures.length; i += 1) {
        await vi.advanceTimersByTimeAsync(intervalMs);
      }

      const sent = messaging.sendToChannel.mock.calls.map((call: any[]) => ({
        channel: call[0],
        content: call[1],
      }));

      expect(sent.map((entry: { channel: string; content: string }) => entry.content)).toEqual(replay.expectedMessages);
      if (replay.expectedMessages.length > 0) {
        expect(sent.every((entry: { channel: string; content: string }) => entry.channel === replay.expectedChannel)).toBe(true);
      }
      expect(pendingTracker.markCompleted).toHaveBeenCalledTimes(replay.expectedCompletedCalls ?? 0);

      poller.stop();
    });
  }
});
