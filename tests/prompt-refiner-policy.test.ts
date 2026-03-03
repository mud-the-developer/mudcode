import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptRefiner } from '../src/prompt/refiner.js';

describe('PromptRefiner policy extraction', () => {
  it('maps GEPA-style instruction wording to concrete operations', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-policy-'));
    try {
      const logPath = join(tempDir, 'shadow.jsonl');
      const policyPath = join(tempDir, 'policy.txt');
      writeFileSync(
        policyPath,
        [
          'You are a prompt refiner.',
          'Rules:',
          '- Strip leading and trailing whitespace.',
          '- Replace multiple spaces with a single space.',
          '- Collapse repeated punctuation marks.',
        ].join('\n'),
        'utf8',
      );

      const refiner = new PromptRefiner({
        mode: 'enforce',
        logPath,
        policyPath,
      });

      const result = refiner.process('  hello   world??  ');
      expect(result.output).toBe('hello world?');

      const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
      expect(entry.policyOperations).toEqual(
        expect.arrayContaining([
          'collapse_consecutive_spaces',
          'remove_duplicate_punctuation',
          'trim_outer_whitespace',
        ]),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports canonical operation tokens without op: prefix', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-policy-'));
    try {
      const policyPath = join(tempDir, 'policy.txt');
      writeFileSync(
        policyPath,
        'Apply collapse_consecutive_spaces and remove_duplicate_punctuation then trim_outer_whitespace.',
        'utf8',
      );

      const refiner = new PromptRefiner({
        mode: 'enforce',
        policyPath,
      });

      const result = refiner.process('  hi   there!!  ');
      expect(result.output).toBe('hi there!');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
