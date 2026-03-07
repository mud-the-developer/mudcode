import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfMetricsCollector, formatPerfMetricsLine } from '../../src/observability/perf-metrics.js';

describe('PerfMetricsCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-03T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks timer aggregates and tmux command counters', () => {
    const collector = new PerfMetricsCollector();

    collector.recordDuration('router_message_latency_ms', 10);
    collector.recordDuration('router_message_latency_ms', 30);
    collector.recordDuration('capture_poll_iteration_ms', 5);
    collector.incrementTmuxExec('send_keys');
    collector.incrementTmuxExec('capture_pane');
    collector.incrementTmuxExec('send_keys');

    const snapshot = collector.snapshot();

    expect(snapshot.timers.router_message_latency_ms.count).toBe(2);
    expect(snapshot.timers.router_message_latency_ms.avgMs).toBe(20);
    expect(snapshot.timers.router_message_latency_ms.minMs).toBe(10);
    expect(snapshot.timers.router_message_latency_ms.maxMs).toBe(30);
    expect(snapshot.counters.tmux_exec_count.total).toBe(3);
    expect(snapshot.counters.tmux_exec_count.byOp.send_keys).toBe(2);
    expect(snapshot.counters.tmux_exec_count.byOp.capture_pane).toBe(1);
  });

  it('tracks state save frequency windows', () => {
    const collector = new PerfMetricsCollector();

    collector.recordDuration('state_save_ms', 2);
    vi.advanceTimersByTime(30_000);
    collector.recordDuration('state_save_ms', 3);
    vi.advanceTimersByTime(4 * 60_000);
    collector.recordDuration('state_save_ms', 4);

    const snapshot = collector.snapshot();

    expect(snapshot.timers.state_save_ms.count).toBe(3);
    expect(snapshot.stateSaveFrequency.inLastMinute).toBe(1);
    expect(snapshot.stateSaveFrequency.inLast5Minutes).toBe(3);
    expect(snapshot.stateSaveFrequency.perMinuteLast5Minutes).toBe(0.6);
    expect(typeof snapshot.stateSaveFrequency.lastAt).toBe('string');
  });

  it('formats a compact single-line summary', () => {
    const collector = new PerfMetricsCollector();
    collector.recordDuration('router_message_latency_ms', 15);
    collector.recordDuration('capture_poll_iteration_ms', 7);
    collector.recordDuration('state_save_ms', 3);
    collector.incrementTmuxExec('send_keys');

    const line = formatPerfMetricsLine(collector.snapshot());

    expect(line).toContain('perf: router');
    expect(line).toContain('poll p95=');
    expect(line).toContain('tmux total=1');
    expect(line).toContain('state-save avg=3ms');
  });
});
