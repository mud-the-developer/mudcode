import { performance } from 'perf_hooks';

const TIMER_RESERVOIR_SIZE = 256;
const STATE_SAVE_FREQUENCY_RETENTION_MS = 60 * 60 * 1000;

type TimerMetricName = 'router_message_latency_ms' | 'capture_poll_iteration_ms' | 'state_save_ms';
type CounterMetricName = 'tmux_exec_count';

type TimerAccumulator = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  reservoir: number[];
  reservoirWrites: number;
};

type CounterAccumulator = {
  total: number;
  byLabel: Map<string, number>;
};

type PerfTimerSnapshot = {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
};

type PerfCounterSnapshot = {
  total: number;
  byOp: Record<string, number>;
};

type StateSaveFrequencySnapshot = {
  lastAt?: string;
  inLastMinute: number;
  inLast5Minutes: number;
  perMinuteLast5Minutes: number;
};

export type PerfMetricsSnapshot = {
  generatedAt: string;
  uptimeMs: number;
  timers: Record<TimerMetricName, PerfTimerSnapshot>;
  counters: {
    tmux_exec_count: PerfCounterSnapshot;
  };
  stateSaveFrequency: StateSaveFrequencySnapshot;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] || 0;

  const rawIndex = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(rawIndex);
  const upper = Math.ceil(rawIndex);
  const lowerValue = sorted[lower] || 0;
  const upperValue = sorted[upper] || 0;

  if (lower === upper) return lowerValue;

  const ratio = rawIndex - lower;
  return lowerValue + (upperValue - lowerValue) * ratio;
}

function createTimerAccumulator(): TimerAccumulator {
  return {
    count: 0,
    totalMs: 0,
    minMs: Number.POSITIVE_INFINITY,
    maxMs: 0,
    lastMs: 0,
    reservoir: [],
    reservoirWrites: 0,
  };
}

function createCounterAccumulator(): CounterAccumulator {
  return {
    total: 0,
    byLabel: new Map<string, number>(),
  };
}

function emptyTimerSnapshot(): PerfTimerSnapshot {
  return {
    count: 0,
    avgMs: 0,
    minMs: 0,
    maxMs: 0,
    lastMs: 0,
    p50Ms: 0,
    p95Ms: 0,
  };
}

function timerSnapshotFromAccumulator(accumulator?: TimerAccumulator): PerfTimerSnapshot {
  if (!accumulator || accumulator.count <= 0) {
    return emptyTimerSnapshot();
  }

  const sampleCount = Math.min(accumulator.reservoirWrites, TIMER_RESERVOIR_SIZE);
  const samples = accumulator.reservoir.slice(0, sampleCount).sort((a, b) => a - b);

  return {
    count: accumulator.count,
    avgMs: round2(accumulator.totalMs / Math.max(1, accumulator.count)),
    minMs: round2(Number.isFinite(accumulator.minMs) ? accumulator.minMs : 0),
    maxMs: round2(accumulator.maxMs),
    lastMs: round2(accumulator.lastMs),
    p50Ms: round2(percentile(samples, 0.5)),
    p95Ms: round2(percentile(samples, 0.95)),
  };
}

function counterSnapshotFromAccumulator(accumulator?: CounterAccumulator): PerfCounterSnapshot {
  if (!accumulator) {
    return { total: 0, byOp: {} };
  }

  const byOp = Object.fromEntries(
    [...accumulator.byLabel.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => [label, value]),
  );

  return {
    total: accumulator.total,
    byOp,
  };
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '0ms';
  if (durationMs < 1000) return `${round2(durationMs)}ms`;
  return `${round2(durationMs / 1000)}s`;
}

function topOperations(byOp: Record<string, number>, limit: number = 3): string {
  const entries = Object.entries(byOp)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .slice(0, limit);

  if (entries.length === 0) return 'none';
  return entries.map(([name, count]) => `${name}:${count}`).join(',');
}

export class PerfMetricsCollector {
  private readonly startedAt = Date.now();
  private timers = new Map<TimerMetricName, TimerAccumulator>();
  private counters = new Map<CounterMetricName, CounterAccumulator>();
  private stateSaveEventsMs: number[] = [];

  private getTimer(metric: TimerMetricName): TimerAccumulator {
    const existing = this.timers.get(metric);
    if (existing) return existing;
    const created = createTimerAccumulator();
    this.timers.set(metric, created);
    return created;
  }

  private getCounter(metric: CounterMetricName): CounterAccumulator {
    const existing = this.counters.get(metric);
    if (existing) return existing;
    const created = createCounterAccumulator();
    this.counters.set(metric, created);
    return created;
  }

  private pruneStateSaveEvents(nowMs: number): void {
    if (this.stateSaveEventsMs.length === 0) return;
    const threshold = nowMs - STATE_SAVE_FREQUENCY_RETENTION_MS;
    while (this.stateSaveEventsMs.length > 0 && (this.stateSaveEventsMs[0] || 0) < threshold) {
      this.stateSaveEventsMs.shift();
    }
  }

  private trackStateSaveEvent(nowMs: number): void {
    this.pruneStateSaveEvents(nowMs);
    this.stateSaveEventsMs.push(nowMs);
  }

  recordDuration(metric: TimerMetricName, durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const normalized = Math.max(0, durationMs);

    const timer = this.getTimer(metric);
    timer.count += 1;
    timer.totalMs += normalized;
    timer.minMs = Math.min(timer.minMs, normalized);
    timer.maxMs = Math.max(timer.maxMs, normalized);
    timer.lastMs = normalized;

    const reservoirIndex = timer.reservoirWrites % TIMER_RESERVOIR_SIZE;
    if (timer.reservoir.length < TIMER_RESERVOIR_SIZE) {
      timer.reservoir.push(normalized);
    } else {
      timer.reservoir[reservoirIndex] = normalized;
    }
    timer.reservoirWrites += 1;

    if (metric === 'state_save_ms') {
      this.trackStateSaveEvent(Date.now());
    }
  }

  startTimer(metric: TimerMetricName): () => void {
    const startedAtMs = performance.now();
    return () => {
      this.recordDuration(metric, performance.now() - startedAtMs);
    };
  }

  incrementCounter(metric: CounterMetricName, label?: string, delta: number = 1): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    const counter = this.getCounter(metric);
    counter.total += delta;

    if (!label) return;
    const normalizedLabel = label.trim().toLowerCase() || 'unknown';
    counter.byLabel.set(normalizedLabel, (counter.byLabel.get(normalizedLabel) || 0) + delta);
  }

  incrementTmuxExec(opType: string): void {
    const normalized = opType.trim().toLowerCase() || 'unknown';
    this.incrementCounter('tmux_exec_count', normalized, 1);
  }

  snapshot(): PerfMetricsSnapshot {
    const now = Date.now();
    this.pruneStateSaveEvents(now);

    const stateSaveLastMinute = this.stateSaveEventsMs.filter((at) => now - at <= 60_000).length;
    const stateSaveLast5Minutes = this.stateSaveEventsMs.filter((at) => now - at <= 5 * 60_000).length;
    const lastStateSave = this.stateSaveEventsMs[this.stateSaveEventsMs.length - 1];

    return {
      generatedAt: new Date(now).toISOString(),
      uptimeMs: Math.max(0, now - this.startedAt),
      timers: {
        router_message_latency_ms: timerSnapshotFromAccumulator(this.timers.get('router_message_latency_ms')),
        capture_poll_iteration_ms: timerSnapshotFromAccumulator(this.timers.get('capture_poll_iteration_ms')),
        state_save_ms: timerSnapshotFromAccumulator(this.timers.get('state_save_ms')),
      },
      counters: {
        tmux_exec_count: counterSnapshotFromAccumulator(this.counters.get('tmux_exec_count')),
      },
      stateSaveFrequency: {
        ...(typeof lastStateSave === 'number' ? { lastAt: new Date(lastStateSave).toISOString() } : {}),
        inLastMinute: stateSaveLastMinute,
        inLast5Minutes: stateSaveLast5Minutes,
        perMinuteLast5Minutes: round2(stateSaveLast5Minutes / 5),
      },
    };
  }

  // Test helper for deterministic assertions.
  resetForTests(): void {
    this.timers.clear();
    this.counters.clear();
    this.stateSaveEventsMs = [];
  }
}

export const perfMetrics = new PerfMetricsCollector();

export function formatPerfMetricsLine(snapshot?: PerfMetricsSnapshot): string {
  if (!snapshot) return 'perf: unavailable';

  const router = snapshot.timers.router_message_latency_ms;
  const capture = snapshot.timers.capture_poll_iteration_ms;
  const stateSave = snapshot.timers.state_save_ms;
  const tmuxExec = snapshot.counters.tmux_exec_count;

  return [
    `perf: router p95=${router.p95Ms}ms(n=${router.count})`,
    `poll p95=${capture.p95Ms}ms(n=${capture.count})`,
    `tmux total=${tmuxExec.total} top=${topOperations(tmuxExec.byOp)}`,
    `state-save avg=${stateSave.avgMs}ms(n=${stateSave.count},1m=${snapshot.stateSaveFrequency.inLastMinute},5m=${snapshot.stateSaveFrequency.inLast5Minutes})`,
    `uptime=${formatDuration(snapshot.uptimeMs)}`,
  ].join(' | ');
}
