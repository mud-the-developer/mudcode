#!/usr/bin/env node

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const DEFAULT_INPUT = join(homedir(), '.mudcode', 'prompt-refiner-shadow.jsonl');
const DEFAULT_OUT_DIR = join(process.cwd(), '.mudcode', 'gepa');
const DEFAULT_PREFIX = 'prompt-refiner-gepa';
const DEFAULT_VAL_RATIO = 0.1;

function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/prompt/prompt-refiner-shadow-to-gepa.mjs [options]',
      '',
      'Options:',
      '  --input <path>       Shadow JSONL path',
      '  --out-dir <dir>      Output directory',
      '  --prefix <name>      Output filename prefix',
      '  --val-ratio <0..1>   Validation split ratio (default: 0.1)',
      '  --all                Include unchanged entries (default: changed-only)',
      '  --help               Show help',
      '',
      'Outputs:',
      `  <out-dir>/${DEFAULT_PREFIX}-train.jsonl`,
      `  <out-dir>/${DEFAULT_PREFIX}-val.jsonl`,
      `  <out-dir>/${DEFAULT_PREFIX}-meta.json`,
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const result = {
    input: process.env.MUDCODE_PROMPT_REFINER_LOG_PATH || DEFAULT_INPUT,
    outDir: process.env.MUDCODE_GEPA_OUT_DIR || DEFAULT_OUT_DIR,
    prefix: process.env.MUDCODE_GEPA_PREFIX || DEFAULT_PREFIX,
    valRatio: DEFAULT_VAL_RATIO,
    includeUnchanged: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--all') {
      result.includeUnchanged = true;
      continue;
    }
    if (token === '--input') {
      result.input = argv[i + 1] || result.input;
      i += 1;
      continue;
    }
    if (token === '--out-dir') {
      result.outDir = argv[i + 1] || result.outDir;
      i += 1;
      continue;
    }
    if (token === '--prefix') {
      result.prefix = argv[i + 1] || result.prefix;
      i += 1;
      continue;
    }
    if (token === '--val-ratio') {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 0.9) {
        result.valRatio = parsed;
      }
      i += 1;
      continue;
    }
  }

  result.input = resolve(result.input);
  result.outDir = resolve(result.outDir);
  return result;
}

function shouldGoToVal(id, valRatio) {
  if (valRatio <= 0) return false;
  const bucket = Number.parseInt(id.slice(0, 8), 16) / 0xffffffff;
  return bucket < valRatio;
}

function parseShadowLine(line) {
  try {
    const parsed = JSON.parse(line);
    const baseline = typeof parsed.baseline === 'string' ? parsed.baseline : '';
    const candidate = typeof parsed.candidate === 'string' ? parsed.candidate : '';
    if (!baseline || !candidate) return null;
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : undefined,
      mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
      changed: !!parsed.changed,
      operations: Array.isArray(parsed.operations) ? parsed.operations.map((x) => String(x)) : [],
      baseline,
      candidate,
      baselineHash: typeof parsed.baselineHash === 'string' ? parsed.baselineHash : hashHex(baseline).slice(0, 16),
      candidateHash: typeof parsed.candidateHash === 'string' ? parsed.candidateHash : hashHex(candidate).slice(0, 16),
      baselineLen: typeof parsed.baselineLen === 'number' ? parsed.baselineLen : baseline.length,
      candidateLen: typeof parsed.candidateLen === 'number' ? parsed.candidateLen : candidate.length,
    };
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (!existsSync(args.input)) {
    console.error(`Shadow log not found: ${args.input}`);
    process.exit(1);
  }

  const raw = readFileSync(args.input, 'utf-8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let parseErrors = 0;
  let filteredUnchanged = 0;
  const dedupByBaselineHash = new Map();

  for (const line of lines) {
    const parsed = parseShadowLine(line);
    if (!parsed) {
      parseErrors += 1;
      continue;
    }
    if (!args.includeUnchanged && !parsed.changed) {
      filteredUnchanged += 1;
      continue;
    }
    dedupByBaselineHash.set(parsed.baselineHash, parsed);
  }

  const deduped = [...dedupByBaselineHash.values()]
    .sort((a, b) => (a.baselineHash < b.baselineHash ? -1 : a.baselineHash > b.baselineHash ? 1 : 0))
    .map((item) => {
      const id = hashHex(`${item.baselineHash}:${item.candidateHash}`).slice(0, 24);
      return {
        id,
        prompt: item.baseline,
        target: item.candidate,
        meta: {
          changed: item.changed,
          operations: item.operations,
          mode: item.mode || 'shadow',
          sourceTs: item.ts,
          baselineHash: item.baselineHash,
          candidateHash: item.candidateHash,
          baselineLen: item.baselineLen,
          candidateLen: item.candidateLen,
        },
      };
    });

  const train = [];
  const val = [];
  for (const sample of deduped) {
    if (shouldGoToVal(sample.id, args.valRatio)) {
      val.push(sample);
    } else {
      train.push(sample);
    }
  }

  mkdirSync(args.outDir, { recursive: true });
  const trainPath = join(args.outDir, `${args.prefix}-train.jsonl`);
  const valPath = join(args.outDir, `${args.prefix}-val.jsonl`);
  const metaPath = join(args.outDir, `${args.prefix}-meta.json`);

  writeFileSync(trainPath, `${train.map((row) => JSON.stringify(row)).join('\n')}${train.length ? '\n' : ''}`, 'utf8');
  writeFileSync(valPath, `${val.map((row) => JSON.stringify(row)).join('\n')}${val.length ? '\n' : ''}`, 'utf8');

  const meta = {
    createdAt: new Date().toISOString(),
    inputPath: args.input,
    includeUnchanged: args.includeUnchanged,
    valRatio: args.valRatio,
    rawLineCount: lines.length,
    parseErrors,
    filteredUnchanged,
    dedupedCount: deduped.length,
    trainCount: train.length,
    valCount: val.length,
    output: {
      trainPath,
      valPath,
    },
  };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  console.log('GEPA dataset export complete');
  console.log(`- input: ${args.input}`);
  console.log(`- raw lines: ${lines.length}`);
  console.log(`- parse errors: ${parseErrors}`);
  console.log(`- filtered unchanged: ${filteredUnchanged}`);
  console.log(`- deduped samples: ${deduped.length}`);
  console.log(`- train: ${train.length} -> ${trainPath}`);
  console.log(`- val: ${val.length} -> ${valPath}`);
  console.log(`- meta: ${metaPath}`);
}

main();
