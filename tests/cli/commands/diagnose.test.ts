import { describe, expect, it } from 'vitest';
import {
  analyzeDiagnosticMessages,
  buildDiagnoseStatusCodeLine,
  buildBoundaryProbeMessage,
  getBoundaryProbeLengths,
} from '../../../src/cli/commands/diagnose.js';

describe('diagnose command parser', () => {
  it('detects known warning/error patterns from channel history text', () => {
    const hits = analyzeDiagnosticMessages([
      '⚠️ No screen updates for 1m on `demo/codex`. It may be stuck.',
      '⚠️ Project "demo" not found in state',
      '⚠️ Agent instance mapping not found for this channel',
      "⚠️ I couldn't deliver your message to the tmux agent session.",
      '⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters',
      '⚠️ tracker queue is empty, but pane still shows working (`Esc to interrupt`)',
    ]);

    expect(hits.find((x) => x.code === 'stale-screen')?.count).toBe(1);
    expect(hits.find((x) => x.code === 'project-missing')?.count).toBe(1);
    expect(hits.find((x) => x.code === 'mapping-missing')?.count).toBe(1);
    expect(hits.find((x) => x.code === 'delivery-failed')?.count).toBe(1);
    expect(hits.find((x) => x.code === 'invalid-message')?.count).toBe(1);
    expect(hits.find((x) => x.code === 'tracker-desync')?.count).toBe(1);
  });

  it('returns empty list when no known patterns exist', () => {
    const hits = analyzeDiagnosticMessages([
      '✅ everything looks healthy',
      'assistant: final answer is ready',
    ]);

    expect(hits).toEqual([]);
  });

  it('builds exact-length boundary probe messages near 2000 chars', () => {
    const lengths = [1990, 1999, 2000];
    for (const length of lengths) {
      const message = buildBoundaryProbeMessage(length, 'nonce', `len${length}`);
      expect(message.length).toBe(length);
      expect(message.startsWith(`[mudcode-diagnose:len${length}:nonce] `)).toBe(true);
    }
  });

  it('returns expected boundary length sets', () => {
    expect(getBoundaryProbeLengths(false)).toEqual([1990, 1999, 2000]);
    expect(getBoundaryProbeLengths(true)).toEqual([1990, 1999, 2000, 2001]);
  });

  it('throws when requested boundary probe length is too short for prefix', () => {
    expect(() => buildBoundaryProbeMessage(8, 'nonce', 'tiny')).toThrow(/too small/i);
  });

  it('builds parseable one-line diagnose status code', () => {
    const line = buildDiagnoseStatusCodeLine({
      result: 'warn',
      probeStatus: 'ok (742ms)',
      ioBoundaryStatus: 'ok',
      patternCount: 2,
      criticalPatterns: false,
      newPatternCount: 1,
    });

    expect(line).toBe(
      'STATUS_CODE MUDCODE_DIAGNOSE=WARN probe=ok_742ms io_boundary=ok patterns=2 critical=0 new_patterns=1',
    );
  });
});
