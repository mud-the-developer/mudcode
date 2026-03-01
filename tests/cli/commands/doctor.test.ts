import { describe, expect, it } from 'vitest';
import {
  classifyLongOutputThreadThreshold,
  rewriteThresholdAssignments,
} from '../../../src/cli/commands/doctor.js';

describe('doctor helpers', () => {
  describe('classifyLongOutputThreadThreshold', () => {
    it('classifies valid values', () => {
      expect(classifyLongOutputThreadThreshold('1200')).toEqual({ kind: 'valid', value: 1200 });
      expect(classifyLongOutputThreadThreshold(20000)).toEqual({ kind: 'valid', value: 20000 });
    });

    it('classifies legacy values', () => {
      expect(classifyLongOutputThreadThreshold('100000')).toEqual({ kind: 'legacy', value: 100000 });
    });

    it('classifies invalid values', () => {
      expect(classifyLongOutputThreadThreshold('abc')).toEqual({ kind: 'invalid', raw: 'abc' });
      expect(classifyLongOutputThreadThreshold('100001')).toEqual({ kind: 'invalid', raw: '100001' });
      expect(classifyLongOutputThreadThreshold('1000')).toEqual({ kind: 'invalid', raw: '1000' });
    });

    it('classifies missing values', () => {
      expect(classifyLongOutputThreadThreshold(undefined)).toEqual({ kind: 'missing' });
      expect(classifyLongOutputThreadThreshold('')).toEqual({ kind: 'missing' });
    });
  });

  describe('rewriteThresholdAssignments', () => {
    it('rewrites legacy and invalid assignments', () => {
      const input = [
        'export AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=100000',
        'AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=not-a-number # comment',
      ].join('\n');

      const result = rewriteThresholdAssignments(input, 20000);
      expect(result.changes).toBe(2);
      expect(result.content).toContain('export AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=20000');
      expect(result.content).toContain('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=20000 # comment');
    });

    it('keeps valid assignment unchanged', () => {
      const input = 'export AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=1800';
      const result = rewriteThresholdAssignments(input, 20000);
      expect(result.changes).toBe(0);
      expect(result.content).toBe(input);
    });
  });
});

