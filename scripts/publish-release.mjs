#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
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

function hasPackageJson(dir) {
  return existsSync(join(dir, 'package.json'));
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
const single = hasFlag('--single');
const tag = argValue('--tag');
const access = argValue('--access') || 'public';
const publishPm = (argValue('--pm') || process.env.DISCODE_PUBLISH_PM || 'npm').trim().toLowerCase();
const requestedScope = normalizeScope(argValue('--scope') || process.env.DISCODE_NPM_SCOPE || '');

if (publishPm !== 'npm' && publishPm !== 'bun') {
  console.error(`Unsupported publish package manager: ${publishPm}`);
  console.error('Use --pm npm or --pm bun');
  process.exit(1);
}

if (requestedScope) {
  process.env.DISCODE_NPM_SCOPE = requestedScope;
  console.log(`Using npm scope: ${requestedScope}`);
}

console.log(`Publishing via: ${publishPm}`);

if (!skipBuild) {
  if (single) {
    if (publishPm === 'bun') {
      run('bun', ['run', 'build:release:binaries:single']);
      run('bun', ['run', 'build:release:npm']);
    } else {
      run('npm', ['run', 'build:release:binaries:single']);
      run('npm', ['run', 'build:release:npm']);
    }
  } else if (publishPm === 'bun') {
    run('bun', ['run', 'build:release']);
  } else {
    run('npm', ['run', 'build:release']);
  }
}

const platformDirs = readdirSync(releaseRoot)
  .map((name) => join(releaseRoot, name))
  .filter((dir) => statSync(dir).isDirectory())
  .filter((dir) => basename(dir) !== 'npm')
  .filter((dir) => {
    if (hasPackageJson(dir)) return true;
    console.log(`Skipping non-package directory: ${dir}`);
    return false;
  })
  .sort((a, b) => basename(a).localeCompare(basename(b)));

const npmMetaDir = join(releaseRoot, 'npm', 'discode');
const publishDirs = [...platformDirs];

if (hasPackageJson(npmMetaDir)) {
  publishDirs.push(npmMetaDir);
} else {
  console.log(`Skipping meta package (missing package.json): ${npmMetaDir}`);
}

if (publishDirs.length === 0) {
  console.error('No releasable package directories found. Run build:release first.');
  process.exit(1);
}

for (const dir of publishDirs) {
  assertScopeIfNeeded(dir, requestedScope);
}

for (const dir of publishDirs) {
  const args = ['publish', '--access', access];
  if (publishPm === 'npm') {
    args.push('--workspaces=false');
  }
  if (tag) args.push('--tag', tag);
  if (dryRun) args.push('--dry-run');
  run(publishPm, args, { cwd: dir });
}

console.log('Release publish flow completed.');
