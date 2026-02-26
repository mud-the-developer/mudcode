#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

const root = resolve(new URL('..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');
const targetProfiles = {
  full: [
    'darwin-arm64',
    'darwin-x64',
    'darwin-x64-baseline',
    'linux-arm64',
    'linux-x64',
    'linux-x64-baseline',
    'linux-arm64-musl',
    'linux-x64-musl',
    'linux-x64-baseline-musl',
    'windows-x64',
    'windows-x64-baseline',
  ],
  linux: [
    'linux-x64',
    'linux-x64-baseline',
    'linux-x64-musl',
    'linux-x64-baseline-musl',
  ],
};

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

function runScript(pm, script, extraArgs = []) {
  if (pm === 'bun') {
    run('bun', ['run', script, ...extraArgs]);
    return;
  }

  const args = ['run', script];
  if (extraArgs.length > 0) {
    args.push('--', ...extraArgs);
  }
  run('npm', args);
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

function resolveProfile(profile) {
  const normalized = (profile || '').trim();
  if (!normalized) return '';
  if (!targetProfiles[normalized]) {
    const supported = Object.keys(targetProfiles).join(', ');
    console.error(`Unknown --profile value: ${normalized}`);
    console.error(`Supported profiles: ${supported}`);
    process.exit(1);
  }
  return normalized;
}

function targetDirNamesForProfile(profile) {
  const suffixes = targetProfiles[profile] || [];
  return suffixes.map((suffix) => `mudcode-${suffix}`);
}

const dryRun = hasFlag('--dry-run');
const skipBuild = hasFlag('--skip-build');
const single = hasFlag('--single');
const tag = argValue('--tag');
const access = argValue('--access') || 'public';
const publishPm = (argValue('--pm') || process.env.MUDCODE_PUBLISH_PM || 'npm').trim().toLowerCase();
const requestedScope = normalizeScope(argValue('--scope') || process.env.MUDCODE_NPM_SCOPE || '');
const requestedProfile = resolveProfile(argValue('--profile') || process.env.MUDCODE_RELEASE_PROFILE || '');

if (publishPm !== 'npm' && publishPm !== 'bun') {
  console.error(`Unsupported publish package manager: ${publishPm}`);
  console.error('Use --pm npm or --pm bun');
  process.exit(1);
}

if (single && requestedProfile) {
  console.error('--single cannot be combined with --profile.');
  process.exit(1);
}

if (requestedScope) {
  process.env.MUDCODE_NPM_SCOPE = requestedScope;
  console.log(`Using npm scope: ${requestedScope}`);
}

console.log(`Publishing via: ${publishPm}`);
if (requestedProfile) {
  console.log(`Release profile: ${requestedProfile}`);
}

if (!skipBuild) {
  if (single) {
    runScript(publishPm, 'build:release:binaries:single');
    runScript(publishPm, 'build:release:npm');
  } else if (requestedProfile) {
    runScript(publishPm, 'build:release:binaries', ['--profile', requestedProfile]);
    runScript(publishPm, 'build:release:npm');
  } else {
    runScript(publishPm, 'build:release');
  }
}

const allowedProfileDirNames = requestedProfile
  ? new Set(targetDirNamesForProfile(requestedProfile))
  : undefined;

const platformDirs = readdirSync(releaseRoot)
  .map((name) => join(releaseRoot, name))
  .filter((dir) => statSync(dir).isDirectory())
  .filter((dir) => basename(dir) !== 'npm')
  .filter((dir) => {
    if (!allowedProfileDirNames) return true;
    return allowedProfileDirNames.has(basename(dir));
  })
  .filter((dir) => {
    if (hasPackageJson(dir)) return true;
    console.log(`Skipping non-package directory: ${dir}`);
    return false;
  })
  .sort((a, b) => basename(a).localeCompare(basename(b)));

if (allowedProfileDirNames) {
  const foundDirNames = new Set(platformDirs.map((dir) => basename(dir)));
  const missing = [...allowedProfileDirNames].filter((name) => !foundDirNames.has(name));
  if (missing.length > 0) {
    console.error(`Missing release artifacts for profile '${requestedProfile}': ${missing.join(', ')}`);
    console.error('Build missing targets first, or remove --profile to publish all available artifacts.');
    process.exit(1);
  }
}

const npmMetaDir = join(releaseRoot, 'npm', 'mudcode');
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
