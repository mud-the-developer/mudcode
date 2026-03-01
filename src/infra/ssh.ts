/**
 * ICommandExecutor implementation that runs commands over SSH.
 */

import { execSync } from 'child_process';
import type { ICommandExecutor } from '../types/interfaces.js';
import { escapeShellArg } from './shell-escape.js';

export interface SshExecutorOptions {
  port?: number;
  identity?: string;
}

export function buildSshExecCommand(
  target: string,
  remoteCommand: string,
  options?: SshExecutorOptions,
): string {
  const parts: string[] = ['ssh', '-o', 'BatchMode=yes'];

  if (typeof options?.port === 'number' && Number.isInteger(options.port) && options.port > 0 && options.port <= 65535) {
    parts.push('-p', String(options.port));
  }

  if (typeof options?.identity === 'string' && options.identity.trim().length > 0) {
    parts.push('-i', options.identity.trim());
  }

  parts.push(target, remoteCommand);
  return parts.map((part) => escapeShellArg(part)).join(' ');
}

export class SshCommandExecutor implements ICommandExecutor {
  private target: string;
  private options?: SshExecutorOptions;

  constructor(target: string, options?: SshExecutorOptions) {
    this.target = target;
    this.options = options;
  }

  exec(command: string, options?: { encoding?: string; stdio?: any }): string {
    const wrapped = buildSshExecCommand(this.target, command, this.options);
    return execSync(wrapped, {
      encoding: (options?.encoding || 'utf-8') as BufferEncoding,
      stdio: options?.stdio,
    }) as string;
  }

  execVoid(command: string, options?: { stdio?: any }): void {
    const wrapped = buildSshExecCommand(this.target, command, this.options);
    execSync(wrapped, { stdio: options?.stdio || 'ignore' });
  }
}
