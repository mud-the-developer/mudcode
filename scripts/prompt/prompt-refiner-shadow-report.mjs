#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_PATH = join(homedir(), '.mudcode', 'prompt-refiner-shadow.jsonl');
const path = process.argv[2] || process.env.MUDCODE_PROMPT_REFINER_LOG_PATH || DEFAULT_PATH;

if (!existsSync(path)) {
  console.error(`Shadow log not found: ${path}`);
  process.exit(1);
}

const raw = readFileSync(path, 'utf-8');
const lines = raw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

let total = 0;
let changed = 0;
let parseErrors = 0;
let baselineLenSum = 0;
let candidateLenSum = 0;
let outputLenSum = 0;
const operationCounts = new Map();

for (const line of lines) {
  total += 1;
  try {
    const entry = JSON.parse(line);
    if (entry.changed) changed += 1;
    baselineLenSum += Number(entry.baselineLen) || 0;
    candidateLenSum += Number(entry.candidateLen) || 0;
    outputLenSum += Number(entry.outputLen) || 0;
    const ops = Array.isArray(entry.operations) ? entry.operations : [];
    for (const op of ops) {
      const key = String(op);
      operationCounts.set(key, (operationCounts.get(key) || 0) + 1);
    }
  } catch {
    parseErrors += 1;
  }
}

const avg = (sum) => (total > 0 ? (sum / total).toFixed(1) : '0.0');
const changedRate = total > 0 ? ((changed / total) * 100).toFixed(1) : '0.0';
const topOps = [...operationCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

console.log(`Prompt refiner shadow report: ${path}`);
console.log(`total entries: ${total}`);
console.log(`changed entries: ${changed} (${changedRate}%)`);
console.log(`parse errors: ${parseErrors}`);
console.log(`avg baseline length: ${avg(baselineLenSum)}`);
console.log(`avg candidate length: ${avg(candidateLenSum)}`);
console.log(`avg output length: ${avg(outputLenSum)}`);
console.log('top operations:');
if (topOps.length === 0) {
  console.log('- (none)');
} else {
  for (const [name, count] of topOps) {
    console.log(`- ${name}: ${count}`);
  }
}

