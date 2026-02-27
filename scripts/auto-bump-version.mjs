#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';

const pkgPath = 'package.json';
const lockPath = 'package-lock.json';

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

if (pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object') {
  for (const key of Object.keys(pkg.optionalDependencies)) {
    if (/\/mudcode-/.test(key)) {
      pkg.optionalDependencies[key] = nextVersion;
    }
  }
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = nextVersion;

  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = nextVersion;
    const rootOptional = lock.packages[''].optionalDependencies;
    if (rootOptional && typeof rootOptional === 'object') {
      for (const key of Object.keys(rootOptional)) {
        if (/\/mudcode-/.test(key)) {
          rootOptional[key] = nextVersion;
        }
      }
    }
  }

  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

process.stdout.write(nextVersion);
