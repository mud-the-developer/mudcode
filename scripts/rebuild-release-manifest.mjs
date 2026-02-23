#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';

const root = resolve(new URL('..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');
const manifestPath = join(releaseRoot, 'manifest.json');

if (!existsSync(releaseRoot)) {
  console.error(`Release directory does not exist: ${releaseRoot}`);
  process.exit(1);
}

const dirs = readdirSync(releaseRoot)
  .map((name) => join(releaseRoot, name))
  .filter((dir) => statSync(dir).isDirectory())
  .filter((dir) => basename(dir) !== 'npm');

const binaries = {};
for (const dir of dirs) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg?.name || !pkg?.version) continue;

  binaries[pkg.name] = pkg.version;
}

if (Object.keys(binaries).length === 0) {
  console.error(`No binary packages found under ${releaseRoot}`);
  process.exit(1);
}

writeFileSync(manifestPath, `${JSON.stringify({ binaries }, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${manifestPath}`);
