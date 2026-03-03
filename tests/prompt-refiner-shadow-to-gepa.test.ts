import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJsonl(path: string): any[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('prompt-refiner-shadow-to-gepa', () => {
  it('prefers changed samples over unchanged duplicates when --all is set', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gepa-export-'));
    try {
      const inputPath = join(tempDir, 'shadow.jsonl');
      const outDir = join(tempDir, 'out');
      const lines = [
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces'],
          baseline: 'hello   world',
          candidate: 'hello world',
          baselineHash: 'base-dup',
          candidateHash: 'cand-changed',
        },
        {
          ts: '2026-03-03T10:00:00Z',
          changed: false,
          operations: [],
          baseline: 'hello   world',
          candidate: 'hello   world',
          baselineHash: 'base-dup',
          candidateHash: 'cand-unchanged',
        },
      ];
      writeFileSync(inputPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
          '--input',
          inputPath,
          '--out-dir',
          outDir,
          '--prefix',
          'sample',
          '--val-ratio',
          '0',
          '--all',
        ],
        { encoding: 'utf8' },
      );

      const trainRows = readJsonl(join(outDir, 'sample-train.jsonl'));
      expect(trainRows).toHaveLength(1);
      expect(trainRows[0].target).toBe('hello world');
      expect(trainRows[0].meta.changed).toBe(true);
      expect(trainRows[0].meta.operations).toContain('collapse_consecutive_spaces');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers richer changed samples when duplicate baseline hashes exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gepa-export-'));
    try {
      const inputPath = join(tempDir, 'shadow.jsonl');
      const outDir = join(tempDir, 'out');
      const lines = [
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: [],
          baseline: '  hello   world!!  ',
          candidate: 'hello   world!!',
          baselineHash: 'base-rich',
          candidateHash: 'cand-weak',
        },
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces', 'remove_duplicate_punctuation', 'trim_outer_whitespace'],
          baseline: '  hello   world!!  ',
          candidate: 'hello world!',
          baselineHash: 'base-rich',
          candidateHash: 'cand-rich',
        },
      ];
      writeFileSync(inputPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
          '--input',
          inputPath,
          '--out-dir',
          outDir,
          '--prefix',
          'sample',
          '--val-ratio',
          '0',
          '--all',
        ],
        { encoding: 'utf8' },
      );

      const trainRows = readJsonl(join(outDir, 'sample-train.jsonl'));
      expect(trainRows).toHaveLength(1);
      expect(trainRows[0].target).toBe('hello world!');
      expect(trainRows[0].meta.operations).toEqual(
        expect.arrayContaining(['collapse_consecutive_spaces', 'remove_duplicate_punctuation', 'trim_outer_whitespace']),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps changed variants when dedupe key is baseline-candidate', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gepa-export-'));
    try {
      const inputPath = join(tempDir, 'shadow.jsonl');
      const outDir = join(tempDir, 'out');
      const lines = [
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces'],
          baseline: 'hello   world',
          candidate: 'hello world',
          baselineHash: 'base-dup',
          candidateHash: 'cand-v1',
        },
        {
          ts: '2026-03-03T10:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces', 'remove_duplicate_punctuation'],
          baseline: 'hello   world',
          candidate: 'hello world!',
          baselineHash: 'base-dup',
          candidateHash: 'cand-v2',
        },
      ];
      writeFileSync(inputPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
          '--input',
          inputPath,
          '--out-dir',
          outDir,
          '--prefix',
          'sample',
          '--val-ratio',
          '0',
          '--dedupe-key',
          'baseline-candidate',
        ],
        { encoding: 'utf8' },
      );

      const trainRows = readJsonl(join(outDir, 'sample-train.jsonl'));
      expect(trainRows).toHaveLength(2);
      expect(trainRows.map((row) => row.target).sort()).toEqual(['hello world', 'hello world!']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('prevents baseline leakage across train/val when split key is baseline', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gepa-export-'));
    try {
      const inputPath = join(tempDir, 'shadow.jsonl');
      const sampleOutDir = join(tempDir, 'out-sample');
      const baselineOutDir = join(tempDir, 'out-baseline');
      const lines = [
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces'],
          baseline: 'hello   world',
          candidate: 'hello world',
          baselineHash: 'base-dup',
          candidateHash: 'cand-0',
        },
        {
          ts: '2026-03-03T10:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces', 'remove_duplicate_punctuation'],
          baseline: 'hello   world',
          candidate: 'hello world!',
          baselineHash: 'base-dup',
          candidateHash: 'cand-3',
        },
      ];
      writeFileSync(inputPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
          '--input',
          inputPath,
          '--out-dir',
          sampleOutDir,
          '--prefix',
          'sample',
          '--val-ratio',
          '0.5',
          '--dedupe-key',
          'baseline-candidate',
        ],
        { encoding: 'utf8' },
      );

      const sampleTrainRows = readJsonl(join(sampleOutDir, 'sample-train.jsonl'));
      const sampleValRows = readJsonl(join(sampleOutDir, 'sample-val.jsonl'));
      expect(sampleTrainRows).toHaveLength(1);
      expect(sampleValRows).toHaveLength(1);

      execFileSync(
        process.execPath,
        [
          resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
          '--input',
          inputPath,
          '--out-dir',
          baselineOutDir,
          '--prefix',
          'sample',
          '--val-ratio',
          '0.5',
          '--dedupe-key',
          'baseline-candidate',
          '--split-key',
          'baseline',
        ],
        { encoding: 'utf8' },
      );

      const baselineTrainRows = readJsonl(join(baselineOutDir, 'sample-train.jsonl'));
      const baselineValRows = readJsonl(join(baselineOutDir, 'sample-val.jsonl'));
      const baselineTrainHashes = new Set(baselineTrainRows.map((row) => row.meta.baselineHash));
      const baselineValHashes = new Set(baselineValRows.map((row) => row.meta.baselineHash));
      expect([...baselineTrainHashes].filter((hash) => baselineValHashes.has(hash))).toHaveLength(0);
      expect(baselineTrainRows.length === 2 || baselineValRows.length === 2).toBe(true);

      const meta = readJson(join(baselineOutDir, 'sample-meta.json'));
      expect(meta.splitKey).toBe('baseline');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps baseline split partitioning deterministic across repeated runs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-gepa-export-'));
    try {
      const inputPath = join(tempDir, 'shadow.jsonl');
      const outDirA = join(tempDir, 'out-a');
      const outDirB = join(tempDir, 'out-b');
      const lines = [
        {
          ts: '2026-03-03T09:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces'],
          baseline: 'hello   world',
          candidate: 'hello world',
          baselineHash: 'base-dup',
          candidateHash: 'cand-0',
        },
        {
          ts: '2026-03-03T10:00:00Z',
          changed: true,
          operations: ['collapse_consecutive_spaces', 'remove_duplicate_punctuation'],
          baseline: 'hello   world',
          candidate: 'hello world!',
          baselineHash: 'base-dup',
          candidateHash: 'cand-3',
        },
        {
          ts: '2026-03-03T11:00:00Z',
          changed: true,
          operations: ['trim_outer_whitespace'],
          baseline: '  second baseline',
          candidate: 'second baseline',
          baselineHash: 'base-second',
          candidateHash: 'cand-second',
        },
      ];
      writeFileSync(inputPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

      const runExport = (outDir: string) =>
        execFileSync(
          process.execPath,
          [
            resolve(process.cwd(), 'scripts/prompt/prompt-refiner-shadow-to-gepa.mjs'),
            '--input',
            inputPath,
            '--out-dir',
            outDir,
            '--prefix',
            'sample',
            '--val-ratio',
            '0.37',
            '--dedupe-key',
            'baseline-candidate',
            '--split-key',
            'baseline',
          ],
          { encoding: 'utf8' },
        );

      runExport(outDirA);
      runExport(outDirB);

      const trainA = readJsonl(join(outDirA, 'sample-train.jsonl')).map((row) => row.id);
      const valA = readJsonl(join(outDirA, 'sample-val.jsonl')).map((row) => row.id);
      const trainB = readJsonl(join(outDirB, 'sample-train.jsonl')).map((row) => row.id);
      const valB = readJsonl(join(outDirB, 'sample-val.jsonl')).map((row) => row.id);
      expect(trainA).toEqual(trainB);
      expect(valA).toEqual(valB);

      const metaA = readJson(join(outDirA, 'sample-meta.json'));
      const metaB = readJson(join(outDirB, 'sample-meta.json'));
      expect(metaA.splitKey).toBe('baseline');
      expect(metaB.splitKey).toBe('baseline');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
