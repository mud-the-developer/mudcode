#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const releaseRoot = join(root, 'dist', 'release');
const npmDir = join(releaseRoot, 'npm');
const metaDir = join(npmDir, 'mudcode');

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(join(releaseRoot, 'manifest.json'), 'utf-8'));
const optionalDependencies = manifest.binaries || {};

function normalizeScope(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function resolvePublishName(pkgName) {
  const envScope = normalizeScope(process.env.MUDCODE_NPM_SCOPE);
  const explicitName = (process.env.MUDCODE_NPM_NAME || '').trim();
  if (explicitName) {
    if (explicitName.startsWith('@')) return explicitName;
    if (envScope) return `${envScope}/${explicitName}`;
  }
  if (envScope) return `${envScope}/mudcode`;

  if (typeof pkgName === 'string' && pkgName.length > 0) return pkgName;
  return '@mudramo/mudcode';
}

rmSync(metaDir, { recursive: true, force: true });
mkdirSync(join(metaDir, 'bin'), { recursive: true });

copyFileSync(join(root, 'bin', 'mudcode'), join(metaDir, 'bin', 'mudcode'));
copyFileSync(join(root, 'scripts', 'postinstall.mjs'), join(metaDir, 'postinstall.mjs'));
copyFileSync(join(root, 'LICENSE'), join(metaDir, 'LICENSE'));
copyFileSync(join(root, 'README.md'), join(metaDir, 'README.md'));
chmodSync(join(metaDir, 'bin', 'mudcode'), 0o755);

const publishPkg = {
  name: resolvePublishName(rootPkg.name),
  version: rootPkg.version,
  description: rootPkg.description,
  license: rootPkg.license,
  bin: {
    mudcode: 'bin/mudcode',
  },
  scripts: {
    postinstall: 'node ./postinstall.mjs',
  },
  optionalDependencies,
};

writeFileSync(join(metaDir, 'package.json'), `${JSON.stringify(publishPkg, null, 2)}\n`, 'utf-8');
console.log(`Prepared npm package at ${metaDir}`);
