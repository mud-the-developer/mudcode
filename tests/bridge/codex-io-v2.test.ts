import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexIoV2Tracker } from '../../src/bridge/codex-io-v2.js';

function createMessagingMock() {
  return {
    platform: 'discord',
    sendToChannel: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('CodexIoV2Tracker', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes turn and delta events to transcript file', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mudcode-io-v2-'));
    tempDirs.push(rootDir);
    const messaging = createMessagingMock();
    const tracker = new CodexIoV2Tracker({
      messaging,
      rootDir,
      announceCommandEvents: false,
      enabled: true,
    });

    tracker.recordPromptSubmitted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      prompt: 'run tests',
    });
    tracker.recordOutputDelta({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      deltaText: 'assistant: started',
    });
    tracker.recordTurnCompleted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      reason: 'quiet-threshold',
    });

    const logPath = tracker.getLatestLogPath('demo', 'codex');
    expect(logPath).toBeDefined();
    const raw = readFileSync(logPath!, 'utf-8');
    expect(raw).toContain('"type":"turn_start"');
    expect(raw).toContain('"type":"delta"');
    expect(raw).toContain('"type":"turn_end"');
  });

  it('announces command start and end when command markers are detected', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mudcode-io-v2-'));
    tempDirs.push(rootDir);
    const messaging = createMessagingMock();
    const tracker = new CodexIoV2Tracker({
      messaging,
      rootDir,
      announceCommandEvents: true,
      enabled: true,
    });

    tracker.recordPromptSubmitted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      prompt: 'show status',
    });
    tracker.recordOutputDelta({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      deltaText: 'Running command: git status\ncommand exited with code 0',
    });
    tracker.recordTurnCompleted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      reason: 'quiet-threshold',
    });

    await Promise.resolve();
    expect(messaging.sendToChannel).toHaveBeenCalledTimes(2);
    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(1, 'ch-1', expect.stringContaining('cmd#1'));
    expect(messaging.sendToChannel).toHaveBeenNthCalledWith(2, 'ch-1', expect.stringContaining('exit 0'));
  });

  it('returns idle status with latest transcript path', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mudcode-io-v2-'));
    tempDirs.push(rootDir);
    const tracker = new CodexIoV2Tracker({
      messaging: createMessagingMock(),
      rootDir,
      announceCommandEvents: false,
      enabled: true,
    });

    tracker.recordPromptSubmitted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      prompt: 'hello',
    });
    tracker.recordTurnCompleted({
      projectName: 'demo',
      instanceId: 'codex',
      channelId: 'ch-1',
      reason: 'quiet-threshold',
    });

    const status = tracker.buildStatus('demo', 'codex');
    expect(status).toContain('i/o idle');
    expect(status).toContain('transcript');
  });
});
