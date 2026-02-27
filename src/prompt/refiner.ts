import { createHash } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { BridgeConfig } from '../types/index.js';

export type PromptRefinerMode = 'off' | 'shadow' | 'enforce';

export interface PromptRefinementOutcome {
  mode: PromptRefinerMode;
  baseline: string;
  candidate: string;
  changed: boolean;
  output: string;
}

type CandidateResult = {
  candidate: string;
  operations: string[];
};

const DEFAULT_SHADOW_LOG_PATH = join(homedir(), '.mudcode', 'prompt-refiner-shadow.jsonl');
const DEFAULT_MAX_LOG_CHARS = 10000;

function normalizeMode(raw: unknown): PromptRefinerMode {
  if (raw === 'shadow' || raw === 'enforce' || raw === 'off') return raw;
  return 'off';
}

function resolveMaxLogChars(raw: unknown): number {
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 500 && value <= 200000) {
    return Math.trunc(value);
  }
  return DEFAULT_MAX_LOG_CHARS;
}

function buildCandidate(input: string): CandidateResult {
  let candidate = input;
  const operations: string[] = [];

  const normalizedLineEndings = candidate.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalizedLineEndings !== candidate) {
    candidate = normalizedLineEndings;
    operations.push('normalize_line_endings');
  }

  const trimmedTrailingSpaces = candidate
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  if (trimmedTrailingSpaces !== candidate) {
    candidate = trimmedTrailingSpaces;
    operations.push('trim_trailing_spaces');
  }

  const collapsedBlankLines = candidate.replace(/\n{3,}/g, '\n\n');
  if (collapsedBlankLines !== candidate) {
    candidate = collapsedBlankLines;
    operations.push('collapse_excess_blank_lines');
  }

  return { candidate, operations };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class PromptRefiner {
  private readonly mode: PromptRefinerMode;
  private readonly logPath: string;
  private readonly maxLogChars: number;
  private logWriteWarned = false;

  constructor(config?: BridgeConfig['promptRefiner']) {
    this.mode = normalizeMode(config?.mode);
    this.logPath = config?.logPath || DEFAULT_SHADOW_LOG_PATH;
    this.maxLogChars = resolveMaxLogChars(config?.maxLogChars);
  }

  getMode(): PromptRefinerMode {
    return this.mode;
  }

  process(input: string): PromptRefinementOutcome {
    if (this.mode === 'off') {
      return {
        mode: 'off',
        baseline: input,
        candidate: input,
        changed: false,
        output: input,
      };
    }

    const { candidate, operations } = buildCandidate(input);
    const changed = candidate !== input;
    const output = this.mode === 'enforce' ? candidate : input;

    this.writeShadowLog({
      baseline: input,
      candidate,
      changed,
      operations,
      outputMode: this.mode,
    });

    return {
      mode: this.mode,
      baseline: input,
      candidate,
      changed,
      output,
    };
  }

  private writeShadowLog(payload: {
    baseline: string;
    candidate: string;
    changed: boolean;
    operations: string[];
    outputMode: PromptRefinerMode;
  }): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });

      const baselineTruncated = payload.baseline.length > this.maxLogChars;
      const candidateTruncated = payload.candidate.length > this.maxLogChars;
      const entry = {
        ts: new Date().toISOString(),
        mode: payload.outputMode,
        changed: payload.changed,
        operations: payload.operations,
        baselineLen: payload.baseline.length,
        candidateLen: payload.candidate.length,
        outputLen: payload.outputMode === 'enforce' ? payload.candidate.length : payload.baseline.length,
        baselineHash: shortHash(payload.baseline),
        candidateHash: shortHash(payload.candidate),
        baselineTruncated,
        candidateTruncated,
        baseline: payload.baseline.slice(0, this.maxLogChars),
        candidate: payload.candidate.slice(0, this.maxLogChars),
      };
      appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      if (this.logWriteWarned) return;
      this.logWriteWarned = true;
      console.warn(
        `Prompt refiner shadow logging failed (${this.logPath}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

