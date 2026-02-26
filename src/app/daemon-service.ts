import { existsSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { defaultDaemonManager } from '../daemon.js';
import type { DaemonLaunchSpec } from '../daemon.js';

export type EnsureDaemonRunningResult = {
  alreadyRunning: boolean;
  ready: boolean;
  port: number;
  logFile: string;
};

function resolveTsDaemonEntryPoint(): string {
  const entryPointCandidates = [
    // Bundled CLI output places daemon entry under dist/src.
    resolve(import.meta.dirname, '../src/daemon-entry.js'),
    // Legacy build layout.
    resolve(import.meta.dirname, '../daemon-entry.js'),
    // Source layout for direct TS execution.
    resolve(import.meta.dirname, '../daemon-entry.ts'),
    resolve(import.meta.dirname, '../src/daemon-entry.ts'),
  ];

  return entryPointCandidates.find((candidate) => existsSync(candidate)) ?? entryPointCandidates[0];
}

function resolveTsDaemonLaunch(): string | DaemonLaunchSpec {
  const executableName = basename(process.execPath).toLowerCase();
  if (executableName === 'mudcode' || executableName === 'mudcode.exe' || executableName === 'mudcode' || executableName === 'mudcode.exe') {
    return {
      command: process.execPath,
      args: ['daemon-runner'],
      keepAwakeOnMac: false,
    };
  }

  return resolveTsDaemonEntryPoint();
}

function resolveRustDaemonLaunch(): DaemonLaunchSpec {
  const binaryFromEnv = process.env.MUDCODE_RS_BIN?.trim();
  if (binaryFromEnv) {
    return {
      command: binaryFromEnv,
      args: [],
    };
  }

  const binName = process.platform === 'win32' ? 'mudcode-rs.exe' : 'mudcode-rs';
  const execDir = dirname(process.execPath);
  const binaryCandidates = [
    resolve(execDir, binName),
    resolve(execDir, 'bin', binName),
    resolve(import.meta.dirname, '../../mudcode-rs/target/release', binName),
    resolve(import.meta.dirname, '../../mudcode-rs/target/debug', binName),
    resolve(import.meta.dirname, '../../../mudcode-rs/target/release', binName),
    resolve(import.meta.dirname, '../../../mudcode-rs/target/debug', binName),
    resolve(process.cwd(), 'mudcode-rs/target/release', binName),
    resolve(process.cwd(), 'mudcode-rs/target/debug', binName),
  ];

  const binary = binaryCandidates.find((candidate) => existsSync(candidate));
  if (binary) {
    return {
      command: binary,
      args: [],
    };
  }

  const manifestFromEnv = process.env.MUDCODE_RS_MANIFEST?.trim();
  const manifestCandidates = [
    manifestFromEnv,
    resolve(import.meta.dirname, '../../mudcode-rs/Cargo.toml'),
    resolve(import.meta.dirname, '../../../mudcode-rs/Cargo.toml'),
    resolve(process.cwd(), 'mudcode-rs/Cargo.toml'),
  ].filter((candidate): candidate is string => !!candidate && candidate.length > 0);

  const manifest = manifestCandidates.find((candidate) => existsSync(candidate));
  if (!manifest) {
    throw new Error(
      'Rust daemon runtime selected, but mudcode-rs was not found. Build mudcode-rs or set MUDCODE_RS_BIN / MUDCODE_RS_MANIFEST.',
    );
  }

  return {
    command: 'cargo',
    args: ['run', '--manifest-path', manifest, '--quiet'],
  };
}

export async function ensureDaemonRunning(): Promise<EnsureDaemonRunningResult> {
  const port = defaultDaemonManager.getPort();
  const logFile = defaultDaemonManager.getLogFile();
  const running = await defaultDaemonManager.isRunning();

  if (running) {
    return {
      alreadyRunning: true,
      ready: true,
      port,
      logFile,
    };
  }

  const runtime = (process.env.MUDCODE_DAEMON_RUNTIME || '').trim().toLowerCase();
  if (runtime === 'rust') {
    defaultDaemonManager.startDaemon(resolveRustDaemonLaunch());
  } else {
    defaultDaemonManager.startDaemon(resolveTsDaemonLaunch());
  }
  const ready = await defaultDaemonManager.waitForReady();

  return {
    alreadyRunning: false,
    ready,
    port,
    logFile,
  };
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  port: number;
  logFile: string;
  pidFile: string;
}> {
  const running = await defaultDaemonManager.isRunning();
  return {
    running,
    port: defaultDaemonManager.getPort(),
    logFile: defaultDaemonManager.getLogFile(),
    pidFile: defaultDaemonManager.getPidFile(),
  };
}

export function stopDaemon(): boolean {
  return defaultDaemonManager.stopDaemon();
}

export async function restartDaemonIfRunning(): Promise<{
  restarted: boolean;
  ready: boolean;
  port: number;
  logFile: string;
}> {
  const status = await getDaemonStatus();
  if (!status.running) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
    };
  }

  const stopped = stopDaemon();
  if (!stopped) {
    return {
      restarted: false,
      ready: false,
      port: status.port,
      logFile: status.logFile,
    };
  }

  const result = await ensureDaemonRunning();
  return {
    restarted: true,
    ready: result.ready,
    port: result.port,
    logFile: result.logFile,
  };
}
