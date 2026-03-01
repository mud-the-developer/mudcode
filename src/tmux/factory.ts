import { SshCommandExecutor } from '../infra/ssh.js';
import type { BridgeConfig } from '../types/index.js';
import type { ICommandExecutor } from '../types/interfaces.js';
import { TmuxManager } from './manager.js';

export interface ResolvedTmuxSshTarget {
  target: string;
  port?: number;
}

export function resolveTmuxSshTarget(rawTarget: string, explicitPort?: number): ResolvedTmuxSshTarget {
  const trimmed = rawTarget.trim();
  if (trimmed.length === 0) {
    throw new Error('tmux ssh target is empty');
  }

  if (explicitPort !== undefined) {
    return { target: trimmed, port: explicitPort };
  }

  const colonMatches = trimmed.match(/:/g) || [];
  if (colonMatches.length === 1) {
    const suffix = trimmed.match(/^(.*):(\d{1,5})$/);
    if (suffix) {
      const parsedPort = Number.parseInt(suffix[2], 10);
      if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
        return {
          target: suffix[1],
          port: parsedPort,
        };
      }
    }
  }

  return { target: trimmed };
}

export function createTmuxManager(
  config: Pick<BridgeConfig, 'tmux' | 'capture'>,
  executor?: ICommandExecutor,
): TmuxManager {
  const options = { captureHistoryLines: config.capture?.historyLines };
  if (executor) {
    return new TmuxManager(config.tmux.sessionPrefix, executor, options);
  }

  if (config.tmux.transport === 'ssh') {
    const target = config.tmux.sshTarget?.trim();
    if (!target) {
      throw new Error('tmux transport is set to ssh but no ssh target is configured');
    }
    const resolved = resolveTmuxSshTarget(target, config.tmux.sshPort);
    const sshExecutor = new SshCommandExecutor(resolved.target, {
      port: resolved.port,
      identity: config.tmux.sshIdentity,
    });
    return new TmuxManager(config.tmux.sessionPrefix, sshExecutor, options);
  }

  return new TmuxManager(config.tmux.sessionPrefix, undefined, options);
}
