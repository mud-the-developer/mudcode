import { describe, expect, it } from 'vitest';
import { normalizeAgentEventPayload } from '../../../src/bridge/runtime/agent-event-payload.js';

describe('normalizeAgentEventPayload', () => {
  it('returns null for non-object payloads', () => {
    expect(normalizeAgentEventPayload(null)).toBeNull();
    expect(normalizeAgentEventPayload(undefined)).toBeNull();
    expect(normalizeAgentEventPayload('oops')).toBeNull();
    expect(normalizeAgentEventPayload(1)).toBeNull();
    expect(normalizeAgentEventPayload([])).toBeNull();
  });

  it('normalizes snake_case aliases to canonical keys', () => {
    const normalized = normalizeAgentEventPayload({
      project_name: 'demo',
      agent_type: 'codex',
      instance_id: 'codex-2',
      event_id: 'evt-1',
      turn_id: 'turn-1',
      sequence: '3',
      event_type: 'session-progress',
      content: 'hello',
      channel_id: 'ch-123',
      source: 'codex-poc',
      progress_mode: 'thread',
      progress_block_streaming: 'true',
      progress_block_window_ms: '400',
      progress_block_max_chars: '1600',
      turn_text: 'full response',
    });

    expect(normalized).toMatchObject({
      projectName: 'demo',
      agentType: 'codex',
      instanceId: 'codex-2',
      eventId: 'evt-1',
      turnId: 'turn-1',
      seq: 3,
      type: 'session.progress',
      text: 'hello',
      channelId: 'ch-123',
      source: 'codex-poc',
      progressMode: 'thread',
      progressBlockStreaming: 'true',
      progressBlockWindowMs: '400',
      progressBlockMaxChars: '1600',
      turnText: 'full response',
    });
  });

  it('keeps canonical fields when both canonical and alias keys are present', () => {
    const normalized = normalizeAgentEventPayload({
      projectName: 'canonical',
      project_name: 'alias',
      eventType: 'session.final',
      event_type: 'session-progress',
      text: 'canonical text',
      message: 'alias text',
    });

    expect(normalized).toMatchObject({
      projectName: 'canonical',
      type: 'session.final',
      text: 'canonical text',
    });
  });
});
