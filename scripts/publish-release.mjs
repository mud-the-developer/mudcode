#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

const root = resolve(new URL('..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');

function normalizeScope(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function argValue(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);

  const index = process.argv.indexOf(name);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith('--')) return next;
  }

  return '';
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function readPackageName(dir) {
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return typeof pkg.name === 'string' ? pkg.name : '';
}

function assertScopeIfNeeded(dir, expectedScope) {
  if (!expectedScope) return;
  const pkgName = readPackageName(dir);
  if (!pkgName.startsWith(`${expectedScope}/`)) {
    console.error(`Scope mismatch in ${dir}`);
    console.error(`  expected: ${expectedScope}/...`);
    console.error(`  actual:   ${pkgName || '(missing name)'}`);
    process.exit(1);
  }
}

const dryRun = hasFlag('--dry-run');
const skipBuild = hasFlag('--skip-build');
const tag = argValue('--tag');
const access = argValue('--access') || 'public';
const requestedScope = normalizeScope(argValue('--scope') || process.env.DISCODE_NPM_SCOPE || '');

if (requestedScope) {
  process.env.DISCODE_NPM_SCOPE = requestedScope;
  console.log(`Using npm scope: ${requestedScope}`);
}

if (!skipBuild) {
  run('npm', ['run', 'build:release']);
}

const platformDirs = readdirSync(releaseRoot)
  .map((name) => join(releaseRoot, name))
  .filter((dir) => statSync(dir).isDirectory())
  .filter((dir) => basename(dir) !== 'npm')
  .sort((a, b) => basename(a).localeCompare(basename(b)));

const npmMetaDir = join(releaseRoot, 'npm', 'discode');
const publishDirs = [...platformDirs, npmMetaDir];

for (const dir of publishDirs) {
  assertScopeIfNeeded(dir, requestedScope);
}

for (const dir of publishDirs) {
  const args = ['publish', '--access', access, '--workspaces=false'];
  if (tag) args.push('--tag', tag);
  if (dryRun) args.push('--dry-run');
  run('npm', args, { cwd: dir });
}

console.log('Release publish flow completed.');
