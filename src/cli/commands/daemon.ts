import chalk from 'chalk';
import { ensureDaemonRunning, getDaemonStatus, stopDaemon, stopDaemonAndWait } from '../../app/daemon-service.js';
import { ensureTmuxInstalled } from '../common/tmux.js';
import { config } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { createTmuxManager } from '../../tmux/factory.js';
import { autoTuneCaptureSettings } from '../common/capture-autotune.js';

export type DaemonCommandOptions = {
  clearSession?: boolean;
  autoTuneCapture?: boolean;
};

function clearManagedTmuxSessions(): { cleared: string[]; failed: string[] } {
  const tmux = createTmuxManager(config);
  const stateSessions = stateManager
    .listProjects()
    .map((project) => project.tmuxSession)
    .filter((sessionName): sessionName is string => typeof sessionName === 'string' && sessionName.trim().length > 0);
  const tmuxSessions = tmux.listSessions().map((session) => session.name);
  const allSessions = [...new Set([...stateSessions, ...tmuxSessions])];

  const cleared: string[] = [];
  const failed: string[] = [];

  for (const sessionName of allSessions) {
    if (!tmux.sessionExistsFull(sessionName)) continue;
    try {
      tmux.killSession(sessionName);
      cleared.push(sessionName);
    } catch {
      failed.push(sessionName);
    }
  }

  return { cleared, failed };
}

export async function daemonCommand(action: string, options: DaemonCommandOptions = {}) {
  const shouldAutoTuneCapture = options.autoTuneCapture !== false;

  function runCaptureAutoTune(): void {
    if (!shouldAutoTuneCapture) return;
    const result = autoTuneCaptureSettings();
    const prefix = result.changed ? '✅' : 'ℹ️';
    const changeSummary = result.changed ? 'updated' : 'kept';
    console.log(
      chalk.gray(
        `${prefix} Capture auto-tune ${changeSummary}: history=${result.tuning.historyLines}, redraw-tail=${result.tuning.redrawTailLines} (active panes: ${result.activeInstances}/${result.scannedInstances}, max lines: ${result.maxObservedLines})`,
      ),
    );
  }

  switch (action) {
    case 'start': {
      ensureTmuxInstalled(config.tmux);
      runCaptureAutoTune();
      const result = await ensureDaemonRunning();
      if (result.alreadyRunning) {
        console.log(chalk.green(`✅ Daemon already running (port ${result.port})`));
        return;
      }
      if (result.ready) {
        console.log(chalk.green(`✅ Daemon started (port ${result.port})`));
      } else {
        console.log(chalk.yellow(`⚠️  Daemon may not be ready. Check logs: ${result.logFile}`));
      }
      break;
    }
    case 'stop': {
      if (stopDaemon()) {
        console.log(chalk.green('✅ Daemon stopped'));
      } else {
        console.log(chalk.gray('Daemon was not running'));
      }
      break;
    }
    case 'status': {
      const status = await getDaemonStatus();
      if (status.running) {
        console.log(chalk.green(`✅ Daemon running (port ${status.port})`));
      } else {
        console.log(chalk.gray('Daemon not running'));
      }
      console.log(chalk.gray(`   Log: ${status.logFile}`));
      console.log(chalk.gray(`   PID: ${status.pidFile}`));
      break;
    }
    case 'restart': {
      ensureTmuxInstalled(config.tmux);
      const status = await getDaemonStatus();
      if (status.running) {
        const stopped = await stopDaemonAndWait();
        if (!stopped) {
          console.log(chalk.yellow('⚠️ Could not stop daemon for restart in time. Try: daemon stop, wait a few seconds, then daemon start.'));
          return;
        }
      }

      if (options.clearSession) {
        const sessionClearResult = clearManagedTmuxSessions();
        if (sessionClearResult.cleared.length > 0) {
          console.log(chalk.green(`✅ Cleared ${sessionClearResult.cleared.length} tmux session(s) before daemon restart.`));
        } else {
          console.log(chalk.gray('No managed tmux sessions were running.'));
        }
        if (sessionClearResult.failed.length > 0) {
          console.log(chalk.yellow(`⚠️ Could not clear tmux session(s): ${sessionClearResult.failed.join(', ')}`));
        }
      }

      runCaptureAutoTune();
      const result = await ensureDaemonRunning();
      if (result.ready) {
        if (status.running) {
          console.log(chalk.green(`✅ Daemon restarted (port ${result.port})`));
        } else {
          console.log(chalk.green(`✅ Daemon started (port ${result.port})`));
        }
      } else {
        const action = status.running ? 'restart' : 'start';
        console.log(chalk.yellow(`⚠️  Daemon may not be ready after ${action}. Check logs: ${result.logFile}`));
      }
      break;
    }
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.log(chalk.gray('Available actions: start, stop, status, restart'));
      process.exit(1);
  }
}
