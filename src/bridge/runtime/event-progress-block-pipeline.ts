type EventProgressActiveMode = 'thread' | 'channel';

interface ProgressBlockState {
  key: string;
  text: string;
  channelId: string;
  mode: EventProgressActiveMode;
}

interface EnqueueParams {
  key: string;
  text: string;
  channelId: string;
  mode: EventProgressActiveMode;
  blockWindowMs: number;
  blockMaxChars: number;
}

export class EventProgressBlockPipeline {
  private blocksByKey = new Map<string, ProgressBlockState>();
  private timersByKey = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onFlush: (params: {
      key: string;
      text: string;
      channelId: string;
      mode: EventProgressActiveMode;
    }) => Promise<void>,
  ) {}

  private longestSuffixPrefix(previous: string, incoming: string): number {
    const max = Math.min(previous.length, incoming.length);
    for (let len = max; len > 0; len -= 1) {
      if (previous.slice(previous.length - len) === incoming.slice(0, len)) {
        return len;
      }
    }
    return 0;
  }

  private merge(previous: string, incoming: string): string {
    const overlap = this.longestSuffixPrefix(previous, incoming);
    const merged = overlap > 0 ? `${previous}${incoming.slice(overlap)}` : `${previous}\n${incoming}`;
    return merged.trim();
  }

  private scheduleFlush(key: string, delayMs: number): void {
    if (this.timersByKey.has(key)) return;
    const timer = setTimeout(() => {
      this.timersByKey.delete(key);
      void this.flush(key).catch((error) => {
        console.warn(`Progress block flush failed (${key}): ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.max(0, Math.trunc(delayMs)));
    timer.unref?.();
    this.timersByKey.set(key, timer);
  }

  clear(key: string): void {
    const timer = this.timersByKey.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timersByKey.delete(key);
    }
    this.blocksByKey.delete(key);
  }

  clearWhere(predicate: (key: string) => boolean): void {
    for (const key of this.blocksByKey.keys()) {
      if (predicate(key)) {
        this.clear(key);
      }
    }
  }

  clearAll(): void {
    for (const key of this.blocksByKey.keys()) {
      this.clear(key);
    }
  }

  async flush(key: string): Promise<void> {
    const state = this.blocksByKey.get(key);
    this.clear(key);
    if (!state) return;
    if (!state.text || state.text.trim().length === 0) return;
    await this.onFlush({
      key,
      text: state.text,
      channelId: state.channelId,
      mode: state.mode,
    });
  }

  async enqueue(params: EnqueueParams): Promise<void> {
    const incoming = params.text.trim();
    if (incoming.length === 0) return;

    const existing = this.blocksByKey.get(params.key);
    const merged = existing ? this.merge(existing.text, incoming) : incoming;
    if (merged.length === 0) return;

    this.blocksByKey.set(params.key, {
      key: params.key,
      text: merged,
      channelId: params.channelId,
      mode: params.mode,
    });

    if (merged.length >= params.blockMaxChars) {
      await this.flush(params.key);
      return;
    }
    this.scheduleFlush(params.key, params.blockWindowMs);
  }
}

