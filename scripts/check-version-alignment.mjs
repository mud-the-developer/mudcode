#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';

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

const errors = [];

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const expectedVersion = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  errors.push(`package.json version is not semver: "${pkg.version}"`);
}

const packageOptional = pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {};
const mudcodeKeys = mudcodeOptionalKeys(packageOptional);
for (const key of mudcodeKeys) {
  if (packageOptional[key] !== expectedVersion) {
    errors.push(`package.json optionalDependency ${key}=${packageOptional[key]} (expected ${expectedVersion})`);
  }
}

if (!existsSync(npmLockPath)) {
  errors.push('package-lock.json is missing');
} else {
  const lock = JSON.parse(readFileSync(npmLockPath, 'utf8'));
  const root = lock.packages && lock.packages[''] ? lock.packages[''] : null;

  if (String(lock.version || '') !== expectedVersion) {
    errors.push(`package-lock.json version=${lock.version} (expected ${expectedVersion})`);
  }
  if (!root) {
    errors.push('package-lock.json is missing packages[""]');
  } else {
    if (String(root.version || '') !== expectedVersion) {
      errors.push(`package-lock.json packages[""].version=${root.version} (expected ${expectedVersion})`);
    }
    const rootOptional = root.optionalDependencies && typeof root.optionalDependencies === 'object' ? root.optionalDependencies : {};
    for (const key of mudcodeKeys) {
      if (rootOptional[key] !== expectedVersion) {
        errors.push(`package-lock.json optionalDependency ${key}=${rootOptional[key]} (expected ${expectedVersion})`);
      }
    }
  }
}

if (!existsSync(bunLockPath)) {
  errors.push('bun.lock is missing');
} else {
  const bunLock = readFileSync(bunLockPath, 'utf8');
  for (const key of mudcodeKeys) {
    const match = bunLock.match(new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`));
    if (!match) {
      errors.push(`bun.lock is missing ${key}`);
      continue;
    }
    if (match[1] !== expectedVersion) {
      errors.push(`bun.lock optionalDependency ${key}=${match[1]} (expected ${expectedVersion})`);
    }
  }
}

if (errors.length > 0) {
  for (const message of errors) {
    console.error(`[version-check] ${message}`);
  }
  process.exit(1);
}

console.log(`[version-check] aligned at ${expectedVersion}`);
