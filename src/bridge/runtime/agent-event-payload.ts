type PayloadRecord = Record<string, unknown>;

function asRecord(payload: unknown): PayloadRecord | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as PayloadRecord;
}

function firstString(record: PayloadRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function firstInteger(record: PayloadRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) continue;
    const integer = Math.trunc(parsed);
    if (integer < 0) continue;
    return integer;
  }
  return undefined;
}

function normalizeEventType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;

  switch (normalized) {
    case 'session-start':
      return 'session.start';
    case 'session-progress':
      return 'session.progress';
    case 'session-final':
      return 'session.final';
    case 'session-idle':
      return 'session.idle';
    case 'session-error':
      return 'session.error';
    case 'session-cancelled':
    case 'session-canceled':
      return 'session.cancelled';
    default:
      return normalized;
  }
}

/**
 * Normalize hook payload keys from snake_case / dash-case aliases into the
 * canonical shape expected by BridgeHookServer.
 */
export function normalizeAgentEventPayload(payload: unknown): PayloadRecord | null {
  const raw = asRecord(payload);
  if (!raw) return null;

  const normalized: PayloadRecord = { ...raw };

  const projectName = firstString(raw, ['projectName', 'project_name', 'project']);
  if (projectName) normalized.projectName = projectName;

  const agentType = firstString(raw, ['agentType', 'agent_type', 'agent']);
  if (agentType) normalized.agentType = agentType;

  const instanceId = firstString(raw, ['instanceId', 'instance_id', 'workerInstanceId', 'worker_instance_id']);
  if (instanceId) normalized.instanceId = instanceId;

  const eventId = firstString(raw, ['eventId', 'event_id', 'id']);
  if (eventId) normalized.eventId = eventId;

  const turnId = firstString(raw, ['turnId', 'turn_id', 'messageId', 'message_id', 'requestId', 'request_id']);
  if (turnId) normalized.turnId = turnId;

  const seq = firstInteger(raw, ['seq', 'sequence', 'eventSeq', 'event_seq']);
  if (typeof seq === 'number') normalized.seq = seq;

  const eventType = normalizeEventType(
    firstString(raw, ['type', 'eventType', 'event_type', 'event', 'hookEventName', 'hook_event_name']),
  );
  if (eventType) normalized.type = eventType;

  const text = firstString(raw, ['text', 'message', 'content', 'output', 'finalText', 'final_text']);
  if (text) normalized.text = text;

  const turnText = firstString(raw, ['turnText', 'turn_text']);
  if (turnText) normalized.turnText = turnText;

  const channelId = firstString(
    raw,
    ['channelId', 'channel_id', 'discordChannelId', 'discord_channel_id', 'routeChannelId', 'route_channel_id', 'channel'],
  );
  if (channelId) normalized.channelId = channelId;

  const source = firstString(raw, ['source', 'eventSource', 'event_source']);
  if (source) normalized.source = source;

  const progressMode = firstString(raw, ['progressMode', 'progress_mode']);
  if (progressMode) normalized.progressMode = progressMode;

  const progressBlockStreaming = raw.progressBlockStreaming ?? raw.progress_block_streaming;
  if (progressBlockStreaming !== undefined) normalized.progressBlockStreaming = progressBlockStreaming;

  const progressBlockWindowMs =
    raw.progressBlockWindowMs ?? raw.progress_block_window_ms ?? raw.progressWindowMs ?? raw.progress_window_ms;
  if (progressBlockWindowMs !== undefined) normalized.progressBlockWindowMs = progressBlockWindowMs;

  const progressBlockMaxChars =
    raw.progressBlockMaxChars ?? raw.progress_block_max_chars ?? raw.progressMaxChars ?? raw.progress_max_chars;
  if (progressBlockMaxChars !== undefined) normalized.progressBlockMaxChars = progressBlockMaxChars;

  return normalized;
}
