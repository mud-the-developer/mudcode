#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

const args = new Set(process.argv.slice(2));
const cleanMode = args.has('--clean');
const checkMode = args.has('--check') || !cleanMode;
const jsonMode = args.has('--json');
const includeProjectDirs = args.has('--include-project-dirs');

const home = homedir();
const cwd = process.cwd();

const legacyPaths = [
  join(home, '.discode'),
  join(home, '.config', 'discode'),
  join(home, '.cache', 'discode'),
  join(home, '.local', 'share', 'discode'),
  join(home, '.npm-global', 'lib', 'node_modules', '@mudramo', 'discode'),
  join(home, '.bun', 'install', 'global', 'node_modules', '@mudramo', 'discode'),
];

if (includeProjectDirs) {
  legacyPaths.push(join(cwd, '.discode'));
}

function findExisting(paths) {
  return paths.filter((path) => existsSync(path));
}

function findLegacyBunCacheEntries() {
  const cacheRoot = join(home, '.bun', 'install', 'cache');
  if (!existsSync(cacheRoot)) return [];

  const level1 = readdirSync(cacheRoot)
    .map((name) => join(cacheRoot, name))
    .filter((candidate) => {
      const base = candidate.split('/').pop() || '';
      return base.toLowerCase().includes('discode');
    });

  const nested = [];
  for (const candidate of readdirSync(cacheRoot).map((name) => join(cacheRoot, name))) {
    let isDir = false;
    try {
      isDir = statSync(candidate).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const child of readdirSync(candidate)) {
      if (!child.toLowerCase().includes('discode')) continue;
      nested.push(join(candidate, child));
    }
  }

  return [...new Set([...level1, ...nested])].filter((path) => existsSync(path));
}

function findLegacyReferencesInMudcodeState() {
  const files = [
    join(home, '.mudcode', 'config.json'),
    join(home, '.mudcode', 'state.json'),
  ];

  const matches = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const body = readFileSync(file, 'utf-8');
      if (body.toLowerCase().includes('discode')) {
        matches.push(file);
      }
    } catch {
      // Ignore unreadable files.
    }
  }

  return matches;
}

function removePaths(paths) {
  const removed = [];
  const failed = [];

  for (const path of paths) {
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { removed, failed };
}

const existingLegacyPaths = findExisting(legacyPaths);
const bunCacheEntries = findLegacyBunCacheEntries();
const legacyRefsInMudcode = findLegacyReferencesInMudcodeState();
const allCandidates = [...existingLegacyPaths, ...bunCacheEntries];

if (jsonMode) {
  const report = {
    mode: cleanMode ? 'clean' : 'check',
    includeProjectDirs,
    found: {
      legacyPaths: existingLegacyPaths,
      bunCacheEntries,
      legacyRefsInMudcode,
      totalRemovalCandidates: allCandidates.length,
    },
  };

  if (!cleanMode) {
    console.log(JSON.stringify(report, null, 2));
    if (checkMode && allCandidates.length > 0) process.exitCode = 1;
    process.exit();
  }

  const removed = removePaths(allCandidates);
  console.log(
    JSON.stringify(
      {
        ...report,
        removed: removed.removed,
        failed: removed.failed,
      },
      null,
      2,
    ),
  );
  if (removed.failed.length > 0) process.exitCode = 1;
  process.exit();
}

console.log('Discode migration check');
console.log(`- Mode: ${cleanMode ? 'clean' : 'check'}`);
console.log(`- Home: ${home}`);
console.log(`- Include project dirs: ${includeProjectDirs ? 'yes' : 'no'}`);
console.log('');

if (allCandidates.length === 0) {
  console.log('No removable discode legacy paths were found.');
} else {
  console.log('Found removable legacy paths:');
  for (const path of allCandidates) {
    console.log(`- ${path}`);
  }
}

if (legacyRefsInMudcode.length > 0) {
  console.log('');
  console.log('Found "discode" references in mudcode state/config:');
  for (const path of legacyRefsInMudcode) {
    console.log(`- ${path}`);
  }
  console.log('Review and clean these references manually if they are stale.');
}

if (!cleanMode) {
  console.log('');
  console.log('Run with --clean to remove the legacy paths above.');
  if (checkMode && allCandidates.length > 0) {
    process.exitCode = 1;
  }
  process.exit();
}

console.log('');
const result = removePaths(allCandidates);
console.log(`Removed: ${result.removed.length}`);
for (const path of result.removed) {
  console.log(`- ${path}`);
}

if (result.failed.length > 0) {
  console.log('');
  console.log(`Failed removals: ${result.failed.length}`);
  for (const failure of result.failed) {
    console.log(`- ${failure.path}: ${failure.error}`);
  }
  process.exitCode = 1;
}
