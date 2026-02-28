#!/usr/bin/env node

import { spawnSync } from 'child_process';

const args = new Set(process.argv.slice(2));
const includeAgents = args.has('--include-agents');
const dirs = ['src', 'tests', 'docs', 'scripts', 'site', 'bin'];
if (includeAgents) {
  dirs.push('.agents');
}

const pattern = String.raw`\b(TODO|FIXME)\b`;
const rgArgs = [
  '-n',
  '--hidden',
  '--glob',
  '!.git',
  '--glob',
  '!node_modules',
  '--glob',
  '!dist',
  '--glob',
  '!scripts/check-todo-fixme.mjs',
  pattern,
  ...dirs,
];

const result = spawnSync('rg', rgArgs, {
  encoding: 'utf8',
  env: process.env,
});

if (result.error && result.error.code === 'ENOENT') {
  console.error('[todo-check] ripgrep (rg) is required but was not found in PATH.');
  process.exit(2);
}

if (result.status === 1) {
  console.log(
    `[todo-check] clean: no TODO/FIXME markers found in ${dirs.join(', ')}`,
  );
  process.exit(0);
}

if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

const output = (result.stdout || '').trim();
if (output.length > 0) {
  console.error('[todo-check] TODO/FIXME markers found:');
  console.error(output);
}
process.exit(1);
