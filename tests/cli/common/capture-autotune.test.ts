import { describe, expect, it } from 'vitest';
import { recommendCaptureTuning } from '../../../src/cli/common/capture-autotune.js';

describe('recommendCaptureTuning', () => {
  it('returns linux baseline when no observed panes', () => {
    expect(recommendCaptureTuning(0, 'linux')).toEqual({
      historyLines: 1200,
      redrawTailLines: 100,
    });
  });

  it('returns non-linux baseline when no observed panes', () => {
    expect(recommendCaptureTuning(0, 'darwin')).toEqual({
      historyLines: 800,
      redrawTailLines: 80,
    });
  });

  it('scales up for deep captures', () => {
    expect(recommendCaptureTuning(1300, 'linux')).toEqual({
      historyLines: 2400,
      redrawTailLines: 140,
    });
  });
});
