import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentEventHookClient } from '../../../src/bridge/events/agent-event-hook.js';

describe('LocalAgentEventHookClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_POC;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does nothing when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: false, port: 19999 });
    const result = await client.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-1',
      channelId: 'ch-1',
    });

    expect(result).toBe(false);
    await vi.runAllTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queues start event asynchronously with generated eventId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const accepted = await client.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-1',
      channelId: 'ch-1',
    });
    expect(accepted).toBe(true);

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      projectName: 'demo',
      agentType: 'codex',
      instanceId: 'codex',
      turnId: 'msg-1',
      type: 'session.start',
      channelId: 'ch-1',
      source: 'codex-poc',
    });
    expect(typeof body.eventId).toBe('string');
    expect(body.eventId).toContain('session.start');
    expect(body.eventId).toContain('msg-1');
  });

  it('increments per-turn sequence for repeated codex start events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const first = await client.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-seq-1',
    });
    const second = await client.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-seq-1',
    });

    expect(first).toBe(true);
    expect(second).toBe(true);

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    const body2 = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(body1.seq).toBe(1);
    expect(body2.seq).toBe(2);
    expect(String(body1.eventId)).toContain('seq-1');
    expect(String(body2.eventId)).toContain('seq-2');
  });

  it('retries queued start event when first delivery fails', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX = '2';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS = '100';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS = '200';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const accepted = await client.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-retry-1',
    });
    expect(accepted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts final event immediately and includes eventId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const ok = await client.emitCodexFinal({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-final-1',
      channelId: 'ch-1',
      text: 'final text',
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      projectName: 'demo',
      agentType: 'codex',
      instanceId: 'codex',
      turnId: 'msg-final-1',
      type: 'session.final',
      text: 'final text',
      channelId: 'ch-1',
      source: 'codex-poc',
    });
    expect(typeof body.eventId).toBe('string');
  });

  it('posts progress event immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const ok = await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-progress-1',
      channelId: 'ch-1',
    });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body));
    expect(body).toMatchObject({
      projectName: 'demo',
      agentType: 'codex',
      instanceId: 'codex',
      turnId: 'msg-progress-1',
      type: 'session.progress',
      channelId: 'ch-1',
      source: 'codex-poc',
    });
  });
});
