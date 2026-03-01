import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import chalk from 'chalk';
import type { BridgeConfig } from '../../types/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { stateManager, type ProjectState } from '../../state/index.js';
import {
  listProjectAgentTypes,
  listProjectInstances,
  normalizeProjectState,
} from '../../state/instances.js';
import { escapeShellArg } from '../../infra/shell-escape.js';
import { buildSshExecCommand } from '../../infra/ssh.js';
import { resolveProjectWindowName, toSharedWindowName } from '../../policy/window-naming.js';
import type { TmuxCliOptions } from './types.js';

export { escapeShellArg, resolveProjectWindowName, toSharedWindowName };

function isSshTmuxTransport(tmuxConfig: BridgeConfig['tmux']): boolean {
  return tmuxConfig.transport === 'ssh' && typeof tmuxConfig.sshTarget === 'string' && tmuxConfig.sshTarget.trim().length > 0;
}

function wrapTmuxCommand(tmuxConfig: BridgeConfig['tmux'], tmuxCommand: string): string {
  if (!isSshTmuxTransport(tmuxConfig)) {
    return tmuxCommand;
  }
  return buildSshExecCommand(tmuxConfig.sshTarget!.trim(), tmuxCommand, {
    port: tmuxConfig.sshPort,
    identity: tmuxConfig.sshIdentity,
  });
}

export function attachToTmux(tmuxConfig: BridgeConfig['tmux'], sessionName: string, windowName?: string): void {
  const sessionTarget = sessionName;
  const windowTarget = windowName ? `${sessionName}:${windowName}` : undefined;
  const tmuxAction = process.env.TMUX ? 'switch-client' : 'attach-session';
  const sessionCommand = wrapTmuxCommand(tmuxConfig, `tmux ${tmuxAction} -t ${escapeShellArg(sessionTarget)}`);

  if (!windowTarget) {
    execSync(sessionCommand, { stdio: 'inherit' });
    return;
  }

  const windowCommand = wrapTmuxCommand(tmuxConfig, `tmux ${tmuxAction} -t ${escapeShellArg(windowTarget)}`);
  try {
    execSync(windowCommand, { stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow(`⚠️ Window '${windowName}' not found, attaching to session '${sessionName}' instead.`));
    execSync(sessionCommand, { stdio: 'inherit' });
  }
}

const TUI_PROCESS_COMMAND_MARKERS = [
  '/dist/bin/mudcode.js tui',
  '/dist/bin/mudcode.js tui',
  '/bin/mudcode.js tui',
  '/bin/mudcode.js tui',
  'mudcode.js tui',
  'mudcode.js tui',
  '/bin/mudcode tui',
  '/bin/mudcode tui',
  'mudcode tui',
  'mudcode tui',
];

function isMudcodeTuiProcess(command: string): boolean {
  return TUI_PROCESS_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

function resolveBunCommand(): string {
  if ((process as { versions?: { bun?: string } }).versions?.bun && process.execPath) {
    return process.execPath;
  }

  try {
    const output = execSync('command -v bun', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
    if (output.length > 0) return output;
  } catch {
    // Fallback to PATH lookup at execution time.
  }

  return 'bun';
}

function listPanePids(target: string): number[] {
  try {
    const output = execSync(`tmux list-panes -t ${escapeShellArg(target)} -F "#{pane_pid}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    const pids = output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 1);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Fall through to direct PID signal.
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function terminateTmuxPaneProcesses(target: string): Promise<number> {
  const panePids = listPanePids(target);
  if (panePids.length === 0) return 0;

  for (const pid of panePids) {
    signalProcessTree(pid, 'SIGTERM');
  }

  await new Promise((resolve) => setTimeout(resolve, 250));

  let forcedKillCount = 0;
  for (const pid of panePids) {
    if (!isProcessRunning(pid)) continue;
    if (signalProcessTree(pid, 'SIGKILL')) {
      forcedKillCount += 1;
    }
  }
  return forcedKillCount;
}

function listActiveTmuxPaneTtys(): Set<string> {
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_tty}"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return new Set(
      output
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/dev/'))
    );
  } catch {
    return new Set();
  }
}

export function cleanupStaleMudcodeTuiProcesses(): number {
  const activePaneTtys = listActiveTmuxPaneTtys();
  if (activePaneTtys.size === 0) return 0;

  let processTable = '';
  try {
    processTable = execSync('ps -axo pid=,ppid=,tty=,command=', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
  } catch {
    return 0;
  }

  type PsRow = {
    pid: number;
    ppid: number;
    tty: string | undefined;
    command: string;
  };

  const rows: PsRow[] = processTable
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const ttyRaw = match[3];
      const tty = ttyRaw === '?' ? undefined : ttyRaw.startsWith('/dev/') ? ttyRaw : `/dev/${ttyRaw}`;
      const command = match[4];
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return [];
      return [{ pid, ppid, tty, command }];
    });

  const tmuxPids = new Set(
    rows
      .filter((row) => row.command === 'tmux')
      .map((row) => row.pid)
  );
  if (tmuxPids.size === 0) return 0;

  let cleaned = 0;
  for (const row of rows) {
    if (!tmuxPids.has(row.ppid)) continue;
    if (!isMudcodeTuiProcess(row.command)) continue;
    if (row.tty && activePaneTtys.has(row.tty)) continue;

    if (signalProcessTree(row.pid, 'SIGTERM')) {
      cleaned += 1;
    }
  }
  return cleaned;
}

export function ensureTmuxInstalled(tmuxConfig?: BridgeConfig['tmux']): void {
  if (process.platform === 'win32') {
    console.error(chalk.red('tmux is required but not available on native Windows.'));
    console.log(chalk.gray('Use WSL, or run on macOS/Linux with tmux installed.'));
    process.exit(1);
  }

  if (tmuxConfig && isSshTmuxTransport(tmuxConfig)) {
    try {
      execSync('ssh -V', { stdio: ['ignore', 'pipe', 'ignore'] });
      return;
    } catch {
      console.error(chalk.red('ssh is required for TMUX_TRANSPORT=ssh but not available in PATH.'));
      process.exit(1);
    }
  }

  try {
    execSync('tmux -V', { stdio: ['ignore', 'pipe', 'ignore'] });
    return;
  } catch {
    console.error(chalk.red('tmux is required but not installed (or not in PATH).'));
    console.log(chalk.gray('Install tmux and retry:'));
    if (process.platform === 'darwin') {
      console.log(chalk.gray('  brew install tmux'));
    } else {
      console.log(chalk.gray('  sudo apt-get install -y tmux   # Debian/Ubuntu'));
      console.log(chalk.gray('  sudo dnf install -y tmux       # Fedora/RHEL'));
    }
    process.exit(1);
  }
}

export function applyTmuxCliOverrides(base: BridgeConfig, options: TmuxCliOptions): BridgeConfig {
  const baseDiscord = base.discord;
  const baseCapture = base.capture;
  const baseTmux = base.tmux;
  const baseHookPort = base.hookServerPort;
  const baseDefaultAgentCli = base.defaultAgentCli;
  const basePromptRefiner = base.promptRefiner;
  const baseOpencode = base.opencode;

  const sharedNameRaw = options?.tmuxSharedSessionName as string | undefined;

  return {
    discord: baseDiscord,
    ...(base.slack ? { slack: base.slack } : {}),
    ...(base.messagingPlatform ? { messagingPlatform: base.messagingPlatform } : {}),
    ...(baseCapture ? { capture: baseCapture } : {}),
    hookServerPort: baseHookPort,
    defaultAgentCli: baseDefaultAgentCli,
    ...(basePromptRefiner ? { promptRefiner: basePromptRefiner } : {}),
    opencode: baseOpencode,
    tmux: {
      ...baseTmux,
      ...(sharedNameRaw !== undefined ? { sharedSessionName: sharedNameRaw } : {}),
    },
  };
}

export function getEnabledAgentNames(project?: ProjectState): string[] {
  if (!project) return [];
  return listProjectAgentTypes(normalizeProjectState(project));
}

export function pruneStaleProjects(tmux: TmuxManager, tmuxConfig: BridgeConfig['tmux']): string[] {
  const removed: string[] = [];
  for (const project of stateManager.listProjects()) {
    const instances = listProjectInstances(project);
    if (instances.length === 0) {
      stateManager.removeProject(project.projectName);
      removed.push(project.projectName);
      continue;
    }

    const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
    const hasLiveWindow = sessionUp && instances.some((instance) => {
      const windowName = resolveProjectWindowName(project, instance.agentType, tmuxConfig, instance.instanceId);
      return tmux.windowExists(project.tmuxSession, windowName);
    });
    if (hasLiveWindow) continue;

    stateManager.removeProject(project.projectName);
    removed.push(project.projectName);
  }
  return removed;
}

export function ensureProjectTuiPane(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  options: TmuxCliOptions,
): void {
  const argvRunner = process.argv[1] ? resolve(process.argv[1]) : undefined;
  const bunCommand = resolveBunCommand();
  const scriptRunnerExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
  let commandParts: string[] | undefined;

  if (argvRunner && existsSync(argvRunner)) {
    const runnerExt = extname(argvRunner).toLowerCase();
    if (scriptRunnerExtensions.has(runnerExt)) {
      commandParts = [bunCommand, argvRunner, 'tui'];
    } else {
      const runnerDir = dirname(argvRunner);
      const sourceRunner = resolve(runnerDir, 'mudcode.ts');
      const sourceRunnerMudcode = resolve(runnerDir, 'mudcode.ts');
      const distRunner = resolve(runnerDir, '../dist/bin/mudcode.js');
      const distRunnerMudcode = resolve(runnerDir, '../dist/bin/mudcode.js');
      if (existsSync(sourceRunner)) {
        commandParts = [bunCommand, sourceRunner, 'tui'];
      } else if (existsSync(sourceRunnerMudcode)) {
        commandParts = [bunCommand, sourceRunnerMudcode, 'tui'];
      } else if (existsSync(distRunner)) {
        commandParts = [bunCommand, distRunner, 'tui'];
      } else if (existsSync(distRunnerMudcode)) {
        commandParts = [bunCommand, distRunnerMudcode, 'tui'];
      } else {
        commandParts = [argvRunner, 'tui'];
      }
    }
  }

  if (!commandParts) {
    const fallbackRunners = [
      resolve(import.meta.dirname, '../../../dist/bin/mudcode.js'),
      resolve(import.meta.dirname, '../../../dist/bin/mudcode.js'),
      resolve(import.meta.dirname, '../../../bin/mudcode.ts'),
      resolve(import.meta.dirname, '../../../bin/mudcode.ts'),
      resolve(import.meta.dirname, '../../../bin/mudcode.js'),
      resolve(import.meta.dirname, '../../../bin/mudcode.js'),
    ];
    const fallbackRunner = fallbackRunners.find((runner) => existsSync(runner));
    commandParts = fallbackRunner ? [bunCommand, fallbackRunner, 'tui'] : [process.execPath, 'tui'];
  }

  if (options.tmuxSharedSessionName) {
    commandParts.push('--tmux-shared-session-name', options.tmuxSharedSessionName);
  }
  const primaryWindowName = '0';
  if (!tmux.windowExists(sessionName, primaryWindowName) && windowName !== primaryWindowName) {
    tmux.ensureWindowAtIndex(sessionName, 0);
  }

  try {
    tmux.ensureTuiPane(sessionName, primaryWindowName, commandParts);
    return;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const missingWindowZero = /can't find window:\s*0\b/.test(errorMessage);
    if (!missingWindowZero || windowName === primaryWindowName) {
      throw error;
    }
  }

  tmux.ensureTuiPane(sessionName, windowName, commandParts);
}
