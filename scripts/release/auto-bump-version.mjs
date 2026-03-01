#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';

const pkgPath = 'package.json';
const npmLockPath = 'package-lock.json';
const bunLockPath = 'bun.lock';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mudcodeOptionalKeys(optionalDependencies) {
  if (!optionalDependencies || typeof optionalDependencies !== 'object') {
    return [];
  }
  return Object.keys(optionalDependencies).filter((key) => /\/mudcode-/.test(key));
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const parts = String(pkg.version || '').split('.');
if (parts.length !== 3) {
  throw new Error(`Unsupported semver format: ${pkg.version}`);
}

const major = Number(parts[0]);
const minor = Number(parts[1]);
const patch = Number(parts[2]);
if (![major, minor, patch].every(Number.isInteger)) {
  throw new Error(`Invalid semver numbers: ${pkg.version}`);
}

const nextVersion = `${major}.${minor}.${patch + 1}`;
pkg.version = nextVersion;

const packageOptional = pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {};
const mudcodeKeys = mudcodeOptionalKeys(packageOptional);
for (const key of mudcodeKeys) {
  packageOptional[key] = nextVersion;
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

if (existsSync(npmLockPath)) {
  const lock = JSON.parse(readFileSync(npmLockPath, 'utf8'));
  lock.version = nextVersion;

  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = nextVersion;
    const rootOptional =
      lock.packages[''].optionalDependencies && typeof lock.packages[''].optionalDependencies === 'object'
        ? lock.packages[''].optionalDependencies
        : {};
    for (const key of mudcodeKeys) {
      rootOptional[key] = nextVersion;
    }
    lock.packages[''].optionalDependencies = rootOptional;
  }

  writeFileSync(npmLockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

if (existsSync(bunLockPath)) {
  let bunLock = readFileSync(bunLockPath, 'utf8');
  const missing = [];

  for (const key of mudcodeKeys) {
    const pattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*")([^"]+)(")`, 'g');
    let found = false;
    bunLock = bunLock.replace(pattern, (_match, prefix, _current, suffix) => {
      found = true;
      return `${prefix}${nextVersion}${suffix}`;
    });
    if (!found) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`bun.lock is missing optionalDependencies entries: ${missing.join(', ')}`);
  }

  writeFileSync(bunLockPath, bunLock, 'utf8');
}

process.stdout.write(nextVersion);
