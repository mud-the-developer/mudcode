#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = {
    train: resolve(process.cwd(), '.mudcode/gepa/prompt-refiner-gepa-train.jsonl'),
    val: resolve(process.cwd(), '.mudcode/gepa/prompt-refiner-gepa-val.jsonl'),
    runDir: resolve(process.cwd(), '.mudcode/codex-opt/run'),
    model: process.env.MUDCODE_CODEX_OPT_MODEL || '',
    iterations: 4,
    subsetTrain: 24,
    subsetVal: 12,
    feedbackExamples: 8,
    changedOnly: false,
    fresh: false,
    smoke: false,
    help: false,
    seedPolicy:
      'You are a prompt refiner for user requests.\n' +
      'Rewrite the user text to be clearer while preserving intent.\n' +
      'Rules:\n' +
      '- Keep the original language and tone.\n' +
      '- Keep technical meaning unchanged.\n' +
      '- Do not add new requirements.\n' +
      '- Return only the rewritten text.\n',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === '--changed-only') {
      out.changedOnly = true;
      continue;
    }
    if (token === '--fresh') {
      out.fresh = true;
      continue;
    }
    if (token === '--smoke') {
      out.smoke = true;
      continue;
    }
    if (token === '--train') {
      out.train = resolve(argv[i + 1] || out.train);
      i += 1;
      continue;
    }
    if (token === '--val') {
      out.val = resolve(argv[i + 1] || out.val);
      i += 1;
      continue;
    }
    if (token === '--run-dir') {
      out.runDir = resolve(argv[i + 1] || out.runDir);
      i += 1;
      continue;
    }
    if (token === '--model') {
      out.model = argv[i + 1] || out.model;
      i += 1;
      continue;
    }
    if (token === '--iterations') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 1) out.iterations = Math.trunc(n);
      i += 1;
      continue;
    }
    if (token === '--subset-train') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 1) out.subsetTrain = Math.trunc(n);
      i += 1;
      continue;
    }
    if (token === '--subset-val') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 1) out.subsetVal = Math.trunc(n);
      i += 1;
      continue;
    }
    if (token === '--feedback-examples') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 1) out.feedbackExamples = Math.trunc(n);
      i += 1;
      continue;
    }
    if (token === '--seed-policy') {
      out.seedPolicy = argv[i + 1] || out.seedPolicy;
      i += 1;
      continue;
    }
  }

  return out;
}

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/prompt/prompt-refiner-codex-optimize.mjs [options]',
      '',
      'Options:',
      '  --train <path>             Train JSONL (default .mudcode/gepa/*-train.jsonl)',
      '  --val <path>               Val JSONL (default .mudcode/gepa/*-val.jsonl)',
      '  --run-dir <dir>            Run output dir (default .mudcode/codex-opt/run)',
      '  --model <name>             Codex model (env: MUDCODE_CODEX_OPT_MODEL)',
      '  --iterations <n>           Optimization rounds (default 4)',
      '  --subset-train <n>         Train subset size (default 24)',
      '  --subset-val <n>           Val subset size (default 12)',
      '  --feedback-examples <n>    Failure examples for proposal prompt (default 8)',
      '  --changed-only             Use only rows with meta.changed=true',
      '  --fresh                    Remove existing run-dir before start',
      '  --smoke                    No Codex call; local heuristic mode',
      '  --seed-policy <text>       Initial policy text',
      '  --help                     Show help',
    ].join('\n'),
  );
}

function normalize(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function tokenF1(a, b) {
  const ta = normalize(a).split(' ').filter(Boolean);
  const tb = normalize(b).split(' ').filter(Boolean);
  if (ta.length === 0 && tb.length === 0) return 1;
  if (ta.length === 0 || tb.length === 0) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of tb) {
    const n = counts.get(t) || 0;
    if (n > 0) {
      counts.set(t, n - 1);
      common += 1;
    }
  }
  if (common === 0) return 0;
  const p = common / tb.length;
  const r = common / ta.length;
  return (2 * p * r) / (p + r);
}

function seqRatio(a, b) {
  const sa = normalize(a);
  const sb = normalize(b);
  if (!sa && !sb) return 1;
  const max = Math.max(sa.length, sb.length);
  if (max === 0) return 1;
  let same = 0;
  const min = Math.min(sa.length, sb.length);
  for (let i = 0; i < min; i += 1) {
    if (sa[i] === sb[i]) same += 1;
  }
  return same / max;
}

function scoreTarget(target, output) {
  const t = String(target || '');
  const o = String(output || '');
  const tNorm = normalize(t);
  const oNorm = normalize(o);
  const containsExact = o.includes(t);
  const exactNorm = tNorm === oNorm;
  const f1 = tokenF1(tNorm, oNorm);
  const seq = seqRatio(tNorm, oNorm);
  let score = 0;
  if (containsExact) score = 1;
  else if (exactNorm) score = 0.95;
  else score = Math.max(0, Math.min(0.9, 0.6 * f1 + 0.3 * seq));
  return { score, containsExact, exactNorm, f1, seq };
}

function stripFence(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : raw;
}

function loadDataset(path, limit, changedOnly) {
  if (!existsSync(path)) throw new Error(`dataset not found: ${path}`);
  const rows = [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const line of lines) {
    const row = JSON.parse(line);
    const prompt = String(row.prompt || '').trim();
    const target = String(row.target || '').trim();
    const changed = Boolean((row.meta || {}).changed);
    if (!prompt || !target) continue;
    if (changedOnly && !changed) continue;
    rows.push({
      id: String(row.id || hashText(`${prompt}\n${target}`).slice(0, 16)),
      prompt,
      target,
      changed,
    });
    if (typeof limit === 'number' && rows.length >= limit) break;
  }
  return rows;
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function codexExec(prompt, { cwd, model, runDir, purpose }) {
  const ioDir = join(runDir, '.codex-io');
  mkdirSync(ioDir, { recursive: true });
  const outPath = join(ioDir, `${Date.now()}-${purpose}-${Math.random().toString(36).slice(2)}.txt`);
  const args = ['exec', '--ephemeral', '--color', 'never', '-C', cwd, '--output-last-message', outPath];
  if (model && model.trim().length > 0) {
    args.push('--model', model.trim());
  }
  const res = spawnSync('codex', args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const stderr = String(res.stderr || '').trim();
    const stdout = String(res.stdout || '').trim();
    throw new Error(`codex exec failed (status=${res.status}): ${stderr || stdout || 'unknown error'}`);
  }
  if (!existsSync(outPath)) {
    throw new Error('codex exec succeeded but output file was not created');
  }
  return stripFence(readFileSync(outPath, 'utf8'));
}

function heuristicRewrite(policy, input) {
  const sys = String(policy || '').toLowerCase();
  let out = String(input || '');
  if (sys.includes('trim')) out = out.trim();
  if (sys.includes('collapse') || sys.includes('spaces')) out = out.replace(/\s+/g, ' ');
  if (sys.includes('duplicate punctuation')) {
    while (out.includes('??') || out.includes('!!')) out = out.replaceAll('??', '?').replaceAll('!!', '!');
  }
  return out;
}

function buildRewritePrompt(policy, userPrompt) {
  return [
    'You are running a prompt refiner policy.',
    'Follow the policy exactly.',
    '',
    'POLICY START',
    policy,
    'POLICY END',
    '',
    'Task: Rewrite the user request to be clearer while preserving intent and language.',
    'Return ONLY the rewritten text.',
    '',
    'User request:',
    userPrompt,
  ].join('\n');
}

function buildProposalPrompt(policy, failures) {
  const body = failures
    .map(
      (f, i) =>
        [
          `Example ${i + 1}:`,
          `Input: ${f.prompt}`,
          `Target: ${f.target}`,
          `Output: ${f.output}`,
          `Score: ${f.score.toFixed(4)}`,
          `Feedback: containsExact=${f.containsExact}, exactNorm=${f.exactNorm}, f1=${f.f1.toFixed(3)}, seq=${f.seq.toFixed(3)}`,
        ].join('\n'),
    )
    .join('\n\n');
  return [
    'You are optimizing a "prompt refiner policy".',
    'Goal: maximize faithfulness to target rewrites while preserving intent/language.',
    'Return ONLY the improved policy text.',
    '',
    'Constraints:',
    '- Keep language of user input unchanged.',
    '- Do not add requirements.',
    '- Keep output concise.',
    '',
    'Current policy:',
    policy,
    '',
    'Failure examples:',
    body || '(none)',
  ].join('\n');
}

function evaluatePolicy({ policy, dataset, smoke, cwd, model, runDir }) {
  const perItem = [];
  for (const row of dataset) {
    const output = smoke
      ? heuristicRewrite(policy, row.prompt)
      : codexExec(buildRewritePrompt(policy, row.prompt), { cwd, model, runDir, purpose: `rewrite-${row.id}` });
    const m = scoreTarget(row.target, output);
    perItem.push({ ...row, output, ...m });
  }
  const avg = perItem.length > 0 ? perItem.reduce((a, b) => a + b.score, 0) / perItem.length : 0;
  return { avg, perItem };
}

function proposePolicy({ currentPolicy, failures, smoke, cwd, model, runDir }) {
  if (smoke) {
    if (!currentPolicy.toLowerCase().includes('collapse consecutive spaces')) {
      return `${currentPolicy}\n- Collapse consecutive spaces.`;
    }
    if (!currentPolicy.toLowerCase().includes('remove duplicate punctuation')) {
      return `${currentPolicy}\n- Remove duplicate punctuation.`;
    }
    return `${currentPolicy}\n- Trim leading/trailing whitespace.`;
  }
  const text = codexExec(buildProposalPrompt(currentPolicy, failures), {
    cwd,
    model,
    runDir,
    purpose: 'proposal',
  });
  return stripFence(text);
}

function writeJson(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(path, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, body ? `${body}\n` : '', 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const cwd = process.cwd();
  if (args.fresh && existsSync(args.runDir)) {
    rmSync(args.runDir, { recursive: true, force: true });
  }
  mkdirSync(args.runDir, { recursive: true });

  let train = loadDataset(args.train, args.subsetTrain, args.changedOnly);
  let val = loadDataset(args.val, args.subsetVal, args.changedOnly);
  if (args.changedOnly && val.length === 0 && train.length >= 2) {
    const fallback = Math.max(1, Math.min(4, Math.floor(train.length / 4)));
    val = train.slice(-fallback);
    train = train.slice(0, -fallback);
  }
  if (train.length === 0) throw new Error('empty train dataset after filtering');
  if (val.length === 0) throw new Error('empty val dataset after filtering');

  const runMeta = {
    ts: new Date().toISOString(),
    trainPath: args.train,
    valPath: args.val,
    trainCount: train.length,
    valCount: val.length,
    iterations: args.iterations,
    changedOnly: args.changedOnly,
    smoke: args.smoke,
    model: args.model || null,
  };
  writeJson(join(args.runDir, 'run-meta.json'), runMeta);

  const iterations = [];
  let bestPolicy = args.seedPolicy;
  const baseVal = evaluatePolicy({
    policy: bestPolicy,
    dataset: val,
    smoke: args.smoke,
    cwd,
    model: args.model,
    runDir: args.runDir,
  });
  let bestValScore = baseVal.avg;
  let bestValPredictions = baseVal.perItem;

  iterations.push({
    iteration: 0,
    phase: 'seed',
    valScore: bestValScore,
    accepted: true,
  });
  console.log(`Iteration 0(seed): val=${bestValScore.toFixed(4)}`);

  for (let i = 1; i <= args.iterations; i += 1) {
    const trainEval = evaluatePolicy({
      policy: bestPolicy,
      dataset: train,
      smoke: args.smoke,
      cwd,
      model: args.model,
      runDir: args.runDir,
    });
    const failures = [...trainEval.perItem]
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.max(1, Math.min(args.feedbackExamples, trainEval.perItem.length)));

    const candidatePolicy = proposePolicy({
      currentPolicy: bestPolicy,
      failures,
      smoke: args.smoke,
      cwd,
      model: args.model,
      runDir: args.runDir,
    });
    const valEval = evaluatePolicy({
      policy: candidatePolicy,
      dataset: val,
      smoke: args.smoke,
      cwd,
      model: args.model,
      runDir: args.runDir,
    });
    const accepted = valEval.avg > bestValScore + 1e-6;
    if (accepted) {
      bestPolicy = candidatePolicy;
      bestValScore = valEval.avg;
      bestValPredictions = valEval.perItem;
    }
    iterations.push({
      iteration: i,
      phase: 'proposal',
      trainScore: trainEval.avg,
      candidateValScore: valEval.avg,
      bestValScore,
      accepted,
    });
    console.log(
      `Iteration ${i}: train=${trainEval.avg.toFixed(4)} candidate_val=${valEval.avg.toFixed(4)} accepted=${accepted}`,
    );
  }

  writeFileSync(join(args.runDir, 'best-policy.txt'), `${bestPolicy.trim()}\n`, 'utf8');
  writeJsonl(join(args.runDir, 'iterations.jsonl'), iterations);
  writeJsonl(
    join(args.runDir, 'best-val-predictions.jsonl'),
    bestValPredictions.map((x) => ({
      id: x.id,
      prompt: x.prompt,
      target: x.target,
      output: x.output,
      score: Number(x.score.toFixed(6)),
    })),
  );
  writeJson(join(args.runDir, 'summary.json'), {
    bestValScore,
    runDir: args.runDir,
    smoke: args.smoke,
    model: args.model || null,
  });

  console.log('Codex optimization complete');
  console.log(`- best val score: ${bestValScore.toFixed(4)}`);
  console.log(`- best policy: ${join(args.runDir, 'best-policy.txt')}`);
  console.log(`- summary: ${join(args.runDir, 'summary.json')}`);
}

main();
