import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, rmSync } from 'fs';
import { LocalAgentEventHookClient } from '../../../src/bridge/events/agent-event-hook.js';

describe('LocalAgentEventHookClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.AGENT_DISCORD_CODEX_EVENT_POC;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX;
    process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH = 'off';
    delete process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS;
    delete process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_RETENTION_MS;
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

  it('is enabled by default and can be disabled via env', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const defaultClient = new LocalAgentEventHookClient({ port: 19999 });
    const defaultAccepted = await defaultClient.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-default-1',
    });
    expect(defaultAccepted).toBe(true);

    process.env.AGENT_DISCORD_CODEX_EVENT_POC = '0';
    const disabledByEnv = new LocalAgentEventHookClient({ port: 19999 });
    const disabledAccepted = await disabledByEnv.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-default-2',
    });
    expect(disabledAccepted).toBe(false);
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

  it('queues final event with generated eventId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const accepted = await client.emitCodexFinal({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-final-1',
      channelId: 'ch-1',
      text: 'final text',
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
      turnId: 'msg-final-1',
      type: 'session.final',
      text: 'final text',
      channelId: 'ch-1',
      source: 'codex-poc',
    });
    expect(typeof body.eventId).toBe('string');
  });

  it('queues progress event asynchronously', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const accepted = await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-progress-1',
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
      turnId: 'msg-progress-1',
      type: 'session.progress',
      channelId: 'ch-1',
      source: 'codex-poc',
    });
  });

  it('retries queued final event when first delivery fails', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX = '2';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS = '100';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS = '200';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    const accepted = await client.emitCodexFinal({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-final-retry-1',
    });
    expect(accepted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps outbox size and drops oldest progress entries first', async () => {
    process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX = '2';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-cap-1',
      text: 'first',
    });
    await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-cap-2',
      text: 'second',
    });
    await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-cap-3',
      text: 'third',
    });

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    const texts = payloads.map((payload) => payload.text);
    expect(texts).not.toContain('first');
    expect(texts).toContain('second');
    expect(texts).toContain('third');
  });

  it('coalesces queued progress events for the same turn to latest payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const client = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-coalesce-1',
      text: 'older',
    });
    await client.emitCodexProgress({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-coalesce-1',
      text: 'latest',
    });

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.type).toBe('session.progress');
    expect(payload.text).toBe('latest');
  });

  it('restores persisted outbox entries after restart', async () => {
    const outboxPath = join(
      tmpdir(),
      `mudcode-hook-outbox-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH = outboxPath;
    process.env.AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS = '0';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX = '3';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_BASE_MS = '100';
    process.env.AGENT_DISCORD_EVENT_HOOK_RETRY_MAX_MS = '100';

    const fetchFail = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchFail);

    const firstClient = new LocalAgentEventHookClient({ enabled: true, port: 19999 });
    await firstClient.emitCodexStart({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-persist-1',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFail).toHaveBeenCalledTimes(1);
    expect(existsSync(outboxPath)).toBe(true);
    const rawPersisted = JSON.parse(readFileSync(outboxPath, 'utf8'));
    expect(Array.isArray(rawPersisted?.outbox)).toBe(true);
    expect(rawPersisted.outbox.length).toBeGreaterThan(0);

    const pendingDrainTimer = (firstClient as any).drainTimer as ReturnType<typeof setTimeout> | undefined;
    if (pendingDrainTimer) {
      clearTimeout(pendingDrainTimer);
      (firstClient as any).drainTimer = undefined;
    }

    const fetchSuccess = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSuccess);
    new LocalAgentEventHookClient({ enabled: true, port: 19999 });

    await vi.advanceTimersByTimeAsync(120);

    expect(fetchSuccess).toHaveBeenCalledTimes(1);
    expect(existsSync(outboxPath)).toBe(false);
    rmSync(outboxPath, { force: true });
  });
});
