/**
 * Daemon manager for running bridge server in background
 * Single global daemon serves all projects on a fixed port
 */

import { spawn } from 'child_process';
import { createConnection } from 'net';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DAEMON_DIR = join(homedir(), '.discord-agent-bridge');
const DEFAULT_PORT = 18470;

export class DaemonManager {
  /**
   * Get the fixed daemon port
   */
  static getPort(): number {
    return DEFAULT_PORT;
  }

  private static pidFile(): string {
    return join(DAEMON_DIR, 'daemon.pid');
  }

  private static logFile(): string {
    return join(DAEMON_DIR, 'daemon.log');
  }

  /**
   * Check if daemon is running on the default port
   */
  static isRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const conn = createConnection({ port: DEFAULT_PORT, host: '127.0.0.1' });
      conn.on('connect', () => {
        conn.destroy();
        resolve(true);
      });
      conn.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Start the global bridge daemon
   */
  static startDaemon(entryPoint: string): number {
    if (!existsSync(DAEMON_DIR)) {
      mkdirSync(DAEMON_DIR, { recursive: true });
    }

    const logFile = DaemonManager.logFile();
    const pidFile = DaemonManager.pidFile();

    const out = openSync(logFile, 'a');
    const err = openSync(logFile, 'a');

    // Use caffeinate on macOS to prevent sleep while daemon is running
    const isMac = process.platform === 'darwin';
    const command = isMac ? 'caffeinate' : 'node';
    const args = isMac ? ['-ims', 'node', entryPoint] : [entryPoint];

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, err],
      env: {
        ...process.env,
        HOOK_SERVER_PORT: String(DEFAULT_PORT),
      },
    });

    child.unref();

    const pid = child.pid!;
    writeFileSync(pidFile, String(pid));

    return pid;
  }

  /**
   * Stop the global daemon
   */
  static stopDaemon(): boolean {
    const pidFile = DaemonManager.pidFile();

    if (!existsSync(pidFile)) {
      return false;
    }

    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      unlinkSync(pidFile);
      return true;
    } catch {
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * Wait for the daemon to start listening
   */
  static async waitForReady(timeoutMs: number = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await DaemonManager.isRunning()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  static getLogFile(): string {
    return DaemonManager.logFile();
  }

  static getPidFile(): string {
    return DaemonManager.pidFile();
  }
}
