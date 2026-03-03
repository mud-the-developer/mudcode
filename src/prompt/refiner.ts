import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
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

type PolicyOperation = 'collapse_consecutive_spaces' | 'remove_duplicate_punctuation' | 'trim_outer_whitespace';

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

function normalizePolicyPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim();
  if (!normalized) return undefined;
  return resolve(normalized);
}

function parseExplicitPolicyOp(raw: string): PolicyOperation | undefined {
  const normalized = raw.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'collapse-consecutive-spaces') return 'collapse_consecutive_spaces';
  if (normalized === 'collapse-multiple-spaces') return 'collapse_consecutive_spaces';
  if (normalized === 'normalize-spaces') return 'collapse_consecutive_spaces';
  if (normalized === 'remove-duplicate-punctuation') return 'remove_duplicate_punctuation';
  if (normalized === 'deduplicate-punctuation') return 'remove_duplicate_punctuation';
  if (normalized === 'collapse-repeated-punctuation') return 'remove_duplicate_punctuation';
  if (normalized === 'trim-outer-whitespace') return 'trim_outer_whitespace';
  if (normalized === 'trim-whitespace') return 'trim_outer_whitespace';
  if (normalized === 'strip-outer-whitespace') return 'trim_outer_whitespace';
  return undefined;
}

function parsePolicyOperations(policyText: string): PolicyOperation[] {
  const operations = new Set<PolicyOperation>();
  const lower = policyText.toLowerCase();

  const explicit = policyText.matchAll(/(?:\bop(?:eration)?\b|\bpolicy[_ -]?op\b)\s*[:=]\s*([a-z0-9_-]+)/gi);
  for (const match of explicit) {
    const parsed = parseExplicitPolicyOp(match[1] || '');
    if (parsed) operations.add(parsed);
  }

  const canonicalNames = lower.matchAll(
    /\b(collapse[_ -]consecutive[_ -]spaces|remove[_ -]duplicate[_ -]punctuation|trim[_ -]outer[_ -]whitespace)\b/g,
  );
  for (const match of canonicalNames) {
    const parsed = parseExplicitPolicyOp(match[1] || '');
    if (parsed) operations.add(parsed);
  }

  if (
    lower.includes('collapse consecutive spaces') ||
    lower.includes('collapse multiple spaces') ||
    lower.includes('normalize spaces') ||
    /\b(collapse|compress|normalize|squash)\s+(?:consecutive|multiple|repeated)?\s*(?:spaces?|whitespace)\b/.test(lower) ||
    /\breplace\s+(?:multiple|repeated)\s+(?:spaces?|whitespace)\s+with\s+(?:a\s+)?single\s+space\b/.test(lower)
  ) {
    operations.add('collapse_consecutive_spaces');
  }
  if (
    lower.includes('remove duplicate punctuation') ||
    lower.includes('deduplicate punctuation') ||
    /\b(remove|dedupe|deduplicate|collapse|normalize)\s+(?:duplicate|repeated|consecutive)\s+punctuation(?:\s+marks?)?\b/.test(
      lower,
    ) ||
    /\b(?:replace|convert)\s+(?:multiple|repeated)\s+(?:question|exclamation)\s+marks?\s+(?:with|to)\s+(?:a\s+)?single\s+mark\b/.test(
      lower,
    )
  ) {
    operations.add('remove_duplicate_punctuation');
  }
  if (
    lower.includes('trim leading/trailing whitespace') ||
    lower.includes('trim surrounding whitespace') ||
    lower.includes('trim outer whitespace') ||
    /\b(trim|strip|remove)\s+(?:leading\s*(?:\/|and)\s*trailing|surrounding|outer)\s+(?:spaces?|whitespace)\b/.test(
      lower,
    ) ||
    /\btrim\s+(?:spaces?|whitespace)\s+at\s+(?:both|the)\s+ends\b/.test(lower)
  ) {
    operations.add('trim_outer_whitespace');
  }

  return Array.from(operations);
}

function buildCandidate(input: string, policyOperations: PolicyOperation[]): CandidateResult {
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

  if (policyOperations.includes('collapse_consecutive_spaces')) {
    const collapsedSpaces = candidate
      .split('\n')
      .map((line) => line.replace(/[ \t]{2,}/g, ' '))
      .join('\n');
    if (collapsedSpaces !== candidate) {
      candidate = collapsedSpaces;
      operations.push('collapse_consecutive_spaces');
    }
  }

  if (policyOperations.includes('remove_duplicate_punctuation')) {
    const dedupedPunctuation = candidate.replace(/([!?])\1+/g, '$1');
    if (dedupedPunctuation !== candidate) {
      candidate = dedupedPunctuation;
      operations.push('remove_duplicate_punctuation');
    }
  }

  if (policyOperations.includes('trim_outer_whitespace')) {
    const trimmedOuterWhitespace = candidate.trim();
    if (trimmedOuterWhitespace !== candidate) {
      candidate = trimmedOuterWhitespace;
      operations.push('trim_outer_whitespace');
    }
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
  private readonly policyPath?: string;
  private logWriteWarned = false;
  private policyReadWarned = false;
  private policyMtimeMs?: number;
  private policyHash?: string;
  private policyOperations: PolicyOperation[] = [];

  constructor(config?: BridgeConfig['promptRefiner']) {
    this.mode = normalizeMode(config?.mode);
    this.logPath = config?.logPath || DEFAULT_SHADOW_LOG_PATH;
    this.maxLogChars = resolveMaxLogChars(config?.maxLogChars);
    this.policyPath = normalizePolicyPath(config?.policyPath || process.env.MUDCODE_PROMPT_REFINER_POLICY_PATH);
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

    const policyOperations = this.loadPolicyOperations();
    const { candidate, operations } = buildCandidate(input, policyOperations);
    const changed = candidate !== input;
    const output = this.mode === 'enforce' ? candidate : input;

    this.writeShadowLog({
      baseline: input,
      candidate,
      changed,
      operations,
      outputMode: this.mode,
      policyPath: this.policyPath,
      policyHash: this.policyHash,
      policyOperations,
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
    policyPath?: string;
    policyHash?: string;
    policyOperations: PolicyOperation[];
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
        policyPath: payload.policyPath || null,
        policyHash: payload.policyHash || null,
        policyOperations: payload.policyOperations,
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

  private loadPolicyOperations(): PolicyOperation[] {
    if (!this.policyPath) {
      this.policyOperations = [];
      this.policyMtimeMs = undefined;
      this.policyHash = undefined;
      return this.policyOperations;
    }

    try {
      const stat = statSync(this.policyPath);
      if (this.policyMtimeMs !== undefined && stat.mtimeMs === this.policyMtimeMs) {
        return this.policyOperations;
      }
      const text = readFileSync(this.policyPath, 'utf8');
      this.policyOperations = parsePolicyOperations(text);
      this.policyMtimeMs = stat.mtimeMs;
      this.policyHash = shortHash(text);
      this.policyReadWarned = false;
      return this.policyOperations;
    } catch (error) {
      this.policyOperations = [];
      this.policyMtimeMs = undefined;
      this.policyHash = undefined;
      const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
        return this.policyOperations;
      }
      if (this.policyReadWarned) return this.policyOperations;
      this.policyReadWarned = true;
      console.warn(
        `Prompt refiner policy read failed (${this.policyPath}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.policyOperations;
    }
  }
}
