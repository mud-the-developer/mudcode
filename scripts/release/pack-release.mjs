#!/usr/bin/env node

import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');

const dirs = readdirSync(releaseRoot)
  .map((name) => join(releaseRoot, name))
  .filter((dir) => statSync(dir).isDirectory())
  .filter((dir) => {
    const name = basename(dir);
    return name !== 'npm';
  });

for (const dir of dirs) {
  console.log(`Packing ${dir}`);
  execSync('npm pack', { cwd: dir, stdio: 'inherit' });
}

const npmMeta = join(releaseRoot, 'npm', 'mudcode');
console.log(`Packing ${npmMeta}`);
execSync('npm pack', { cwd: npmMeta, stdio: 'inherit' });
