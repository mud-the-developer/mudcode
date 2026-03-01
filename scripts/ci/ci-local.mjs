#!/usr/bin/env node

import { spawnSync } from 'child_process';

const args = new Set(process.argv.slice(2));

function run(command, commandArgs) {
  console.log(`> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function hasTmux() {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveE2eMode() {
  if (args.has('--no-e2e')) return 'skip';
  if (args.has('--with-e2e')) return 'required';

  const envRaw = (process.env.MUDCODE_CI_E2E_TMUX || '').trim().toLowerCase();
  if (envRaw === '0' || envRaw === 'false' || envRaw === 'no') return 'skip';
  if (envRaw === '1' || envRaw === 'true' || envRaw === 'yes' || envRaw === 'required') return 'required';
  return 'auto';
}

run('npm', ['run', 'typecheck']);
run('npm', ['run', 'todo:check']);
run('npm', ['test']);

const e2eMode = resolveE2eMode();
const tmuxAvailable = hasTmux();
if (e2eMode === 'skip') {
  console.log('Skipping tmux e2e tests (--no-e2e or MUDCODE_CI_E2E_TMUX disabled).');
  process.exit(0);
}

if (!tmuxAvailable) {
  if (e2eMode === 'required') {
    console.error('tmux is not available, but e2e tests were required.');
    process.exit(1);
  }
  console.log('tmux not found, skipping tmux e2e tests (auto mode).');
  process.exit(0);
}

run('npm', ['run', 'test:e2e:tmux']);
