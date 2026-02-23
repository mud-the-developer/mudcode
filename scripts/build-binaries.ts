#!/usr/bin/env bun

import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join, resolve } from 'path';
import solidPlugin from '../node_modules/@opentui/solid/scripts/solid-plugin';

declare const Bun: any;

type Target = {
  os: 'darwin' | 'linux' | 'windows';
  arch: 'x64' | 'arm64';
  baseline?: boolean;
  abi?: 'musl';
};

const root = resolve(import.meta.dirname, '..');
const outRoot = join(root, 'dist', 'release');
const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  name: string;
  version: string;
};

function normalizeScope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function resolvePackageScope(packageName: string): string {
  const envScope = process.env.DISCODE_NPM_SCOPE;
  if (envScope) {
    const normalized = normalizeScope(envScope);
    if (normalized) return normalized;
  }

  const match = packageName.match(/^(@[^/]+)\//);
  if (match) return match[1];

  return '@siisee11';
}

const packageScope = resolvePackageScope(pkgJson.name);

const allTargets: Target[] = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'x64', baseline: true },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'x64', baseline: true },
  { os: 'linux', arch: 'arm64', abi: 'musl' },
  { os: 'linux', arch: 'x64', abi: 'musl' },
  { os: 'linux', arch: 'x64', baseline: true, abi: 'musl' },
  { os: 'windows', arch: 'x64' },
  { os: 'windows', arch: 'x64', baseline: true },
];

const single = process.argv.includes('--single');
const platformMap: Record<NodeJS.Platform, Target['os'] | undefined> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  netbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
};
const currentOs = platformMap[process.platform];
const currentArch = process.arch === 'arm64' || process.arch === 'x64' ? process.arch : undefined;
const targets =
  single && currentOs && currentArch
    ? allTargets.filter((t) => t.os === currentOs && t.arch === currentArch && !t.baseline && !t.abi)
    : allTargets;

if (targets.length === 0) {
  throw new Error('No matching build targets found.');
}

let localRustBuildAttempted = false;
let localRustBuildSucceeded = false;

function rustBinaryNameForTarget(target: Target): string {
  return target.os === 'windows' ? 'discode-rs.exe' : 'discode-rs';
}

function rustEnvNameForSuffix(suffix: string): string {
  return `DISCODE_RS_BIN_${suffix.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function isHostCompatibleTarget(target: Target): boolean {
  return target.os === currentOs && target.arch === currentArch && !target.baseline && !target.abi;
}

function nodeOsForTarget(target: Target): 'darwin' | 'linux' | 'win32' {
  return target.os === 'windows' ? 'win32' : target.os;
}

function resolveOpenTuiRuntimeModule(target: Target): { moduleName: string; modulePath: string } {
  const nodeOs = nodeOsForTarget(target);
  const moduleName = `@opentui/core-${nodeOs}-${target.arch}`;
  const modulePath = join(root, 'node_modules', moduleName, 'index.ts');
  return { moduleName, modulePath };
}

function isLocalArchOsTarget(target: Target): boolean {
  return target.os === currentOs && target.arch === currentArch;
}

function ensureLocalRustReleaseBuilt(): boolean {
  if (localRustBuildAttempted) return localRustBuildSucceeded;
  localRustBuildAttempted = true;

  if (process.env.DISCODE_RS_SKIP_LOCAL_BUILD === '1') {
    console.log('  - Skipping local Rust build (DISCODE_RS_SKIP_LOCAL_BUILD=1)');
    localRustBuildSucceeded = false;
    return false;
  }

  const manifest = join(root, 'discode-rs', 'Cargo.toml');
  if (!existsSync(manifest)) {
    localRustBuildSucceeded = false;
    return false;
  }

  console.log('  - Building local Rust daemon sidecar (cargo build --release)');
  const result = spawnSync(
    'cargo',
    ['build', '--manifest-path', manifest, '--release'],
    { stdio: 'inherit' },
  );
  localRustBuildSucceeded = result.status === 0;
  if (!localRustBuildSucceeded) {
    console.log('  - Local Rust build failed; continuing without sidecar.');
  }

  return localRustBuildSucceeded;
}

function resolveRustBinaryPath(target: Target, suffix: string): string | null {
  const rustBinaryName = rustBinaryNameForTarget(target);

  const specificEnv = process.env[rustEnvNameForSuffix(suffix)];
  if (specificEnv && existsSync(specificEnv)) return specificEnv;

  const genericEnv = process.env.DISCODE_RS_BIN;
  if (genericEnv && existsSync(genericEnv)) return genericEnv;

  const prebuiltDir = process.env.DISCODE_RS_PREBUILT_DIR;
  if (prebuiltDir) {
    const prebuiltCandidates = [
      join(prebuiltDir, `discode-rs-${suffix}`),
      join(prebuiltDir, `discode-rs-${suffix}.exe`),
      join(prebuiltDir, `discode-rs-${suffix}-${target.os}-${target.arch}`),
      join(prebuiltDir, rustBinaryName),
    ];
    const prebuilt = prebuiltCandidates.find((candidate) => existsSync(candidate));
    if (prebuilt) return prebuilt;
  }

  if (isHostCompatibleTarget(target)) {
    const releaseCandidate = join(root, 'discode-rs', 'target', 'release', rustBinaryName);
    if (!existsSync(releaseCandidate)) {
      ensureLocalRustReleaseBuilt();
    }

    const localCandidates = [
      releaseCandidate,
      join(root, 'discode-rs', 'target', 'debug', rustBinaryName),
    ];
    const local = localCandidates.find((candidate) => existsSync(candidate));
    if (local) return local;
  }

  return null;
}

function tryAttachRustDaemonBinary(target: Target, suffix: string, binDir: string): void {
  const rustBinaryName = rustBinaryNameForTarget(target);
  const source = resolveRustBinaryPath(target, suffix);
  if (!source) {
    console.log(
      `  - Rust daemon sidecar not found for ${suffix}. ` +
      `Set ${rustEnvNameForSuffix(suffix)} / DISCODE_RS_BIN / DISCODE_RS_PREBUILT_DIR to include it.`,
    );
    return;
  }

  const destination = join(binDir, rustBinaryName);
  copyFileSync(source, destination);
  if (target.os !== 'windows') {
    chmodSync(destination, 0o755);
  }
  console.log(`  - Attached Rust daemon sidecar: ${source} -> ${destination}`);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const binaries: Record<string, string> = {};

for (const target of targets) {
  const suffix = [target.os, target.arch, target.baseline ? 'baseline' : undefined, target.abi]
    .filter(Boolean)
    .join('-');
  const packageName = `${packageScope}/discode-${suffix}`;
  const compileTarget = `bun-${suffix}`;
  const packageDirName = packageName.split('/')[1] || packageName;
  const packageDir = join(outRoot, packageDirName);
  const binDir = join(packageDir, 'bin');
  const binaryName = target.os === 'windows' ? 'discode.exe' : 'discode';
  const outfile = join(binDir, binaryName);

  console.log(`Building ${packageName} (${compileTarget})`);

  // OpenTUI loads a platform package by runtime OS/arch during bundling.
  // On a single host, foreign OS/arch target packages are typically not installed.
  // Skip those foreign targets unless the matching package is present locally.
  const openTuiRuntime = resolveOpenTuiRuntimeModule(target);
  if (!existsSync(openTuiRuntime.modulePath)) {
    if (isLocalArchOsTarget(target)) {
      throw new Error(
        `Missing required module ${openTuiRuntime.moduleName} for local target ${suffix}. ` +
        `Run 'bun install' first.`,
      );
    }

    console.log(
      `  - Skipping ${packageName}: missing ${openTuiRuntime.moduleName}. ` +
      `Build this target on a matching runner or install that optional package explicitly.`,
    );
    continue;
  }

  mkdirSync(binDir, { recursive: true });

  const result = await Bun.build({
    plugins: [solidPlugin],
    entrypoints: ['./bin/discode.ts', './bin/tui.tsx'],
    target: 'bun',
    sourcemap: 'external',
    compile: {
      target: compileTarget as any,
      outfile,
      windows: {},
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: true,
      autoloadTsconfig: true,
      execArgv: ['--'],
    },
    define: {
      DISCODE_VERSION: `'${pkgJson.version}'`,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Build failed for ${packageName}`);
  }

  tryAttachRustDaemonBinary(target, suffix, binDir);

  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: packageName,
        version: pkgJson.version,
        os: [target.os === 'windows' ? 'win32' : target.os],
        cpu: [target.arch],
        license: 'MIT',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  binaries[packageName] = pkgJson.version;
}

const manifestPath = join(outRoot, 'manifest.json');
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify({ binaries }, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${manifestPath}`);
