#!/usr/bin/env bun

/**
 * CLI entry point for mudcode
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { Argv } from 'yargs';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { newCommand } from '../src/cli/commands/new.js';
import { attachCommand } from '../src/cli/commands/attach.js';
import { stopCommand } from '../src/cli/commands/stop.js';
import { tuiCommand } from '../src/cli/commands/tui.js';
import { onboardCommand } from '../src/cli/commands/onboard.js';
import { startCommand } from '../src/cli/commands/start.js';
import { configCommand } from '../src/cli/commands/config.js';
import { statusCommand } from '../src/cli/commands/status.js';
import { healthCommand } from '../src/cli/commands/health.js';
import { listCommand } from '../src/cli/commands/list.js';
import { agentsCommand } from '../src/cli/commands/agents.js';
import { daemonCommand } from '../src/cli/commands/daemon.js';
import { uninstallCommand } from '../src/cli/commands/uninstall.js';
import { getDaemonStatus, restartDaemonIfRunning } from '../src/app/daemon-service.js';
import { main as daemonMain } from '../src/index.js';
import { config } from '../src/config/index.js';
import { stateManager } from '../src/state/index.js';
import { agentRegistry } from '../src/agents/index.js';
import { TmuxManager } from '../src/tmux/manager.js';
import { listProjectInstances, normalizeProjectState } from '../src/state/instances.js';
import { buildAgentLaunchEnv, buildExportPrefix } from '../src/policy/agent-launch.js';
import { addTmuxOptions } from '../src/cli/common/options.js';
import { confirmYesNo, isInteractiveShell } from '../src/cli/common/interactive.js';

export { newCommand, attachCommand, stopCommand };

declare const MUDCODE_VERSION: string | undefined;
const CLI_COMMAND_NAME = 'mudcode';

function resolveCliPackageName(): string {
  const fromEnv = process.env.MUDCODE_NPM_PACKAGE?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    resolve(import.meta.dirname, '../package.json'),
    resolve(import.meta.dirname, '../../package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // Try next candidate.
    }
  }

  return process.env.npm_package_name || '@mudramo/mudcode';
}

function resolveCliVersion(): string {
  if (typeof MUDCODE_VERSION !== 'undefined' && MUDCODE_VERSION) {
    return MUDCODE_VERSION;
  }

  const candidates = [
    resolve(import.meta.dirname, '../package.json'),
    resolve(import.meta.dirname, '../../package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try next candidate.
    }
  }

  return process.env.npm_package_version || '0.0.0';
}

const CLI_VERSION = resolveCliVersion();
const CLI_PACKAGE_NAME = resolveCliPackageName();

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }

  for (let i = 0; i < 3; i += 1) {
    if (parsedA[i] > parsedB[i]) return 1;
    if (parsedA[i] < parsedB[i]) return -1;
  }
  return 0;
}

function isSourceRuntime(): boolean {
  const argv1 = process.argv[1] || '';
  return argv1.endsWith('.ts') || argv1.endsWith('.tsx') || argv1.includes('/bin/mudcode.ts');
}

function hasCommand(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function commandNameFromArgs(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

async function fetchLatestCliVersion(timeoutMs: number = 2500): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(CLI_PACKAGE_NAME)}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type UpgradeInstallPlan = {
  label: string;
  command: string;
};

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function detectUpgradeInstallPlan(): UpgradeInstallPlan | null {
  if (hasCommand('npm')) {
    return { label: 'npm', command: `npm install -g ${CLI_PACKAGE_NAME}@latest` };
  }
  if (hasCommand('bun')) {
    return { label: 'bun', command: `bun add -g ${CLI_PACKAGE_NAME}@latest` };
  }
  return null;
}

async function performSelfUpgrade(): Promise<boolean> {
  const plan = detectUpgradeInstallPlan();
  if (!plan) {
    console.log(chalk.yellow('⚠️ No supported package manager found for auto-upgrade.'));
    console.log(chalk.gray(`   Install manually: npm install -g ${CLI_PACKAGE_NAME}@latest`));
    return false;
  }

  try {
    console.log(chalk.gray(`   Running: ${plan.command}`));
    execSync(plan.command, { stdio: 'inherit' });
    console.log(chalk.green(`✅ Updated to latest via ${plan.label}`));
    await restartDaemonIfRunningForUpgrade();
    return true;
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Auto-upgrade failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.gray(`   You can retry manually: npm install -g ${CLI_PACKAGE_NAME}@latest`));
    return false;
  }
}

function detectLocalUpgradeInstallPlan(repoPath: string): UpgradeInstallPlan | null {
  const escapedRepoPath = shellEscapeArg(repoPath);
  if (hasCommand('npm')) {
    return {
      label: 'npm',
      command: `npm install -g ${escapedRepoPath}`,
    };
  }
  if (hasCommand('bun')) {
    return {
      label: 'bun',
      command: `bun add -g ${escapedRepoPath}`,
    };
  }
  return null;
}

function isGitRepository(repoPath: string): boolean {
  try {
    execSync(`git -C ${shellEscapeArg(repoPath)} rev-parse --is-inside-work-tree`, {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

async function performGitUpgrade(options: { repo?: string }): Promise<boolean> {
  const repoPath = resolve(options.repo?.trim() || process.env.MUDCODE_GIT_REPO_PATH?.trim() || process.cwd());
  if (!isGitRepository(repoPath)) {
    console.log(chalk.yellow(`⚠️ Not a git repository: ${repoPath}`));
    console.log(chalk.gray(`   Run from your mudcode repo, or pass: ${CLI_COMMAND_NAME} update --git --repo /path/to/mudcode`));
    return false;
  }
  if (!existsSync(resolve(repoPath, 'package.json'))) {
    console.log(chalk.yellow(`⚠️ package.json not found in repo path: ${repoPath}`));
    return false;
  }

  try {
    console.log(chalk.gray(`   Pulling latest code from git: ${repoPath}`));
    execSync(`git -C ${shellEscapeArg(repoPath)} pull --rebase --autostash`, { stdio: 'inherit' });
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Git pull failed: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }

  const plan = detectLocalUpgradeInstallPlan(repoPath);
  if (!plan) {
    console.log(chalk.yellow('⚠️ No supported package manager found for local install.'));
    console.log(chalk.gray(`   Install manually: npm install -g ${shellEscapeArg(repoPath)}`));
    return false;
  }

  try {
    console.log(chalk.gray(`   Installing from local git checkout via ${plan.label}...`));
    console.log(chalk.gray(`   Running: ${plan.command}`));
    execSync(plan.command, { stdio: 'inherit' });
    console.log(chalk.green(`✅ Updated from git checkout: ${repoPath}`));
    await restartDaemonIfRunningForUpgrade();
    return true;
  } catch (error) {
    console.log(chalk.yellow(`⚠️ Local install failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.gray(`   Retry manually: ${plan.command}`));
    return false;
  }
}

async function restartDaemonIfRunningForUpgrade(): Promise<void> {
  const status = await getDaemonStatus();
  const port = status.port || config.hookServerPort || 18470;
  if (!status.running) {
    await restartRunningCodexPanesForUpgrade(port);
    return;
  }

  console.log(chalk.gray('   Restarting bridge daemon to apply update...'));

  const restart = await restartDaemonIfRunning();
  if (!restart.restarted) {
    console.log(
      chalk.yellow(
        `⚠️ Could not restart daemon automatically. Restart manually with: ${CLI_COMMAND_NAME} daemon stop && ${CLI_COMMAND_NAME} daemon start`,
      ),
    );
    return;
  }

  if (restart.ready) {
    console.log(chalk.green(`✅ Bridge daemon restarted (port ${port})`));
  } else {
    console.log(chalk.yellow(`⚠️ Daemon may not be ready yet. Check logs: ${restart.logFile}`));
  }

  await restartRunningCodexPanesForUpgrade(port);
}

function shouldRestartCodexPanesOnUpgrade(): boolean {
  const raw = process.env.MUDCODE_RESTART_CODEX_ON_UPDATE?.trim().toLowerCase();
  if (!raw) return true;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

async function restartRunningCodexPanesForUpgrade(port: number): Promise<void> {
  if (!shouldRestartCodexPanesOnUpgrade()) return;

  const codexAdapter = agentRegistry.get('codex');
  if (!codexAdapter) return;

  const projects = stateManager.listProjects();
  if (projects.length === 0) return;

  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  let restartedCount = 0;
  let failedCount = 0;
  let sawCodexInstance = false;

  for (const rawProject of projects) {
    const project = normalizeProjectState(rawProject);
    for (const instance of listProjectInstances(project)) {
      if (instance.agentType !== 'codex') continue;
      sawCodexInstance = true;

      const windowName = instance.tmuxWindow || instance.instanceId;
      if (!windowName) continue;
      if (!tmux.sessionExistsFull(project.tmuxSession)) continue;
      if (!tmux.windowExists(project.tmuxSession, windowName)) continue;

      const launchCommand =
        buildExportPrefix(
          buildAgentLaunchEnv({
            projectName: project.projectName,
            port,
            agentType: instance.agentType,
            instanceId: instance.instanceId,
            permissionAllow: false,
          }),
        ) + codexAdapter.getStartCommand(project.projectPath);

      try {
        tmux.respawnPaneInWindow(project.tmuxSession, windowName, launchCommand, 'codex');
        restartedCount += 1;
      } catch (error) {
        failedCount += 1;
        console.log(
          chalk.yellow(
            `⚠️ Could not restart Codex pane ${project.tmuxSession}:${windowName}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }

  if (!sawCodexInstance) return;

  if (restartedCount > 0) {
    console.log(chalk.green(`✅ Restarted ${restartedCount} running Codex pane(s) to apply update immediately.`));
  }
  if (failedCount > 0) {
    console.log(
      chalk.yellow(
        `⚠️ ${failedCount} Codex pane(s) failed to restart. Re-run manually with: ${CLI_COMMAND_NAME} new codex --name <project>`,
      ),
    );
  }
}

function shouldCheckForUpdate(rawArgs: string[]): boolean {
  if (!isInteractiveShell()) return false;
  if (process.env.MUDCODE_SKIP_UPDATE_CHECK === '1') return false;
  if (isSourceRuntime()) return false;
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v')) return false;

  const command = commandNameFromArgs(rawArgs);
  if (!command) return false;

  if (command === 'tui' || command === 'daemon' || command === 'daemon-runner' || command === 'update') return false;
  return true;
}

async function maybePromptForUpgrade(rawArgs: string[]): Promise<void> {
  if (!shouldCheckForUpdate(rawArgs)) return;

  const latestVersion = await fetchLatestCliVersion();
  if (!latestVersion) return;
  if (compareSemver(latestVersion, CLI_VERSION) <= 0) return;

  console.log(chalk.cyan(`\n⬆️  A new Mudcode version is available: ${CLI_VERSION} → ${latestVersion}`));
  const shouldUpgrade = await confirmYesNo(chalk.white('Upgrade now? [Y/n]: '), true);
  if (!shouldUpgrade) {
    console.log(chalk.gray('   Skipping update for now.'));
    return;
  }

  await performSelfUpgrade();
}

async function runUpdateCommand(options: { check?: boolean; git?: boolean; repo?: string }): Promise<void> {
  if (options.git) {
    await performGitUpgrade({ repo: options.repo });
    return;
  }

  const latestVersion = await fetchLatestCliVersion(4000);
  if (!latestVersion) {
    console.log(chalk.yellow('⚠️ Could not fetch the latest version from npm registry.'));
    console.log(chalk.gray(`   Retry later or run: npm install -g ${CLI_PACKAGE_NAME}@latest`));
    return;
  }

  const diff = compareSemver(latestVersion, CLI_VERSION);
  if (diff <= 0) {
    console.log(chalk.green(`✅ ${CLI_COMMAND_NAME} is up to date (${CLI_VERSION})`));
    return;
  }

  console.log(chalk.cyan(`⬆️  Update available: ${CLI_VERSION} → ${latestVersion}`));
  if (options.check) {
    console.log(chalk.gray(`   Run \`${CLI_COMMAND_NAME} update\` to install.`));
    return;
  }

  await performSelfUpgrade();
}

export async function runCli(rawArgs: string[] = hideBin(process.argv)): Promise<void> {
  await maybePromptForUpgrade(rawArgs);

  await yargs(rawArgs)
    .scriptName(CLI_COMMAND_NAME)
    .usage('$0 [command]')
    .version(CLI_VERSION)
    .help()
    .strict()
    .command(
      ['$0', 'tui'],
      'Interactive terminal UI (supports /new)',
      (y: Argv) => addTmuxOptions(y),
      async (argv: any) =>
        tuiCommand({
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'onboard',
      'One-time onboarding: save token, choose default AI CLI, configure OpenCode permission',
      (y: Argv) => y
        .option('platform', { type: 'string', choices: ['discord', 'slack'], describe: 'Messaging platform to use' })
        .option('token', { alias: 't', type: 'string', describe: 'Discord bot token (optional; prompt if omitted)' })
        .option('slack-bot-token', { type: 'string', describe: 'Slack bot token (xoxb-...)' })
        .option('slack-app-token', { type: 'string', describe: 'Slack app-level token (xapp-...)' }),
      async (argv: any) => onboardCommand({
        platform: argv.platform,
        token: argv.token,
        slackBotToken: argv.slackBotToken,
        slackAppToken: argv.slackAppToken,
      })
    )
    .command(
      'setup [token]',
      false,
      (y: Argv) => y.positional('token', { type: 'string', describe: 'Discord bot token (deprecated)' }),
      async (argv: any) => {
        console.log(chalk.yellow(`⚠️ \`setup\` is deprecated. Use \`${CLI_COMMAND_NAME} onboard\` instead.`));
        await onboardCommand({ token: argv.token });
      }
    )
    .command(
      'start',
      'Start the Discord bridge server',
      (y: Argv) => addTmuxOptions(y)
        .option('project', { alias: 'p', type: 'string', describe: 'Start for specific project only' })
        .option('attach', { alias: 'a', type: 'boolean', describe: 'Attach to tmux session after starting (requires --project)' }),
      async (argv: any) =>
        startCommand({
          project: argv.project,
          attach: argv.attach,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'new [agent]',
      'Quick start: launch daemon, setup project, attach tmux',
      (y: Argv) => addTmuxOptions(y)
        .positional('agent', { type: 'string', describe: 'Agent to use (claude, gemini, opencode, codex)' })
        .option('name', { alias: 'n', type: 'string', describe: 'Project name (defaults to directory name)' })
        .option('instance', { type: 'string', describe: 'Agent instance ID (e.g. gemini-2)' })
        .option('attach', { type: 'boolean', default: true, describe: 'Attach to tmux session after setup' }),
      async (argv: any) =>
        newCommand(argv.agent, {
          name: argv.name,
          instance: argv.instance,
          attach: argv.attach,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'config',
      'Configure bridge settings',
      (y: Argv) => y
        .option('server', { alias: 's', type: 'string', describe: 'Set Discord server / Slack workspace ID' })
        .option('token', { alias: 't', type: 'string', describe: 'Set Discord bot token' })
        .option('channel', { alias: 'c', type: 'string', describe: 'Set default Discord channel ID override' })
        .option('port', { alias: 'p', type: 'string', describe: 'Set hook server port' })
        .option('default-agent', { type: 'string', describe: 'Set default AI CLI for `mudcode new`' })
        .option('platform', { type: 'string', choices: ['discord', 'slack'], describe: 'Set messaging platform' })
        .option('slack-bot-token', { type: 'string', describe: 'Set Slack bot token (xoxb-...)' })
        .option('slack-app-token', { type: 'string', describe: 'Set Slack app-level token (xapp-...)' })
        .option('opencode-permission', {
          type: 'string',
          choices: ['allow', 'default'],
          describe: 'Set OpenCode permission mode',
        })
        .option('prompt-refiner-mode', {
          type: 'string',
          choices: ['off', 'shadow', 'enforce'],
          describe: 'Set prompt refiner mode',
        })
        .option('prompt-refiner-log-path', {
          type: 'string',
          describe: 'Set prompt refiner JSONL log path (use "default" to reset)',
        })
        .option('show', { type: 'boolean', describe: 'Show current configuration' }),
      async (argv: any) =>
        configCommand({
          show: argv.show,
          server: argv.server,
          token: argv.token,
          channel: argv.channel,
          port: argv.port,
          defaultAgent: argv.defaultAgent,
          opencodePermission: argv.opencodePermission,
          promptRefinerMode: argv.promptRefinerMode,
          promptRefinerLogPath: argv.promptRefinerLogPath,
          platform: argv.platform,
          slackBotToken: argv.slackBotToken,
          slackAppToken: argv.slackAppToken,
        })
    )
    .command(
      'status',
      'Show bridge and project status',
      (y: Argv) => addTmuxOptions(y),
      (argv: any) =>
        statusCommand({
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'health',
      'Run one-shot diagnostics for config, daemon, tmux, and channel mappings',
      (y: Argv) => addTmuxOptions(y)
        .option('json', { type: 'boolean', default: false, describe: 'Print machine-readable JSON output' }),
      async (argv: any) =>
        healthCommand({
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
          json: argv.json,
        })
    )
    .command(
      'list',
      'List all configured projects',
      (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
      (argv: any) => listCommand({ prune: argv.prune })
    )
    .command(
      'ls',
      false,
      (y: Argv) => y.option('prune', { type: 'boolean', describe: 'Remove projects whose tmux window is not running' }),
      (argv: any) => listCommand({ prune: argv.prune })
    )
    .command('agents', 'List available AI agent adapters', () => {}, () => agentsCommand())
    .command(
      'attach [project]',
      'Attach to a project tmux session',
      (y: Argv) => addTmuxOptions(y)
        .positional('project', { type: 'string' })
        .option('instance', { type: 'string', describe: 'Attach specific instance ID' }),
      (argv: any) =>
        attachCommand(argv.project, {
          instance: argv.instance,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'stop [project]',
      'Stop a project (kills tmux session, deletes Discord channel)',
      (y: Argv) => addTmuxOptions(y)
        .positional('project', { type: 'string' })
        .option('instance', { type: 'string', describe: 'Stop only a specific instance ID' })
        .option('keep-channel', { type: 'boolean', describe: 'Keep Discord channel (only kill tmux)' }),
      async (argv: any) =>
        stopCommand(argv.project, {
          keepChannel: argv.keepChannel,
          instance: argv.instance,
          tmuxSharedSessionName: argv.tmuxSharedSessionName,
        })
    )
    .command(
      'daemon <action>',
      'Manage the global bridge daemon (start|stop|status|restart)',
      (y: Argv) => y
        .positional('action', { type: 'string', demandOption: true })
        .option('clear-session', {
          type: 'boolean',
          default: false,
          describe: 'Restart only: kill managed tmux sessions before daemon start',
        })
        .option('auto-tune-capture', {
          type: 'boolean',
          default: true,
          describe: 'Probe active tmux panes and auto-tune capture settings before start/restart',
        }),
      async (argv: any) => daemonCommand(argv.action, { clearSession: argv.clearSession, autoTuneCapture: argv.autoTuneCapture })
    )
    .command(
      'update',
      'Update mudcode to the latest version',
      (y: Argv) =>
        y
          .option('check', { type: 'boolean', default: false, describe: 'Only check for updates (npm registry)' })
          .option('git', { type: 'boolean', default: false, describe: 'Update from a local git checkout (git pull + global reinstall)' })
          .option('repo', { type: 'string', describe: 'Repo path for --git (default: $MUDCODE_GIT_REPO_PATH or current directory)' }),
      async (argv: any) => runUpdateCommand({ check: argv.check, git: argv.git, repo: argv.repo })
    )
    .command(
      'daemon-runner',
      false,
      () => {},
      async () => {
        await daemonMain();
      }
    )
    .command(
      'uninstall',
      'Uninstall mudcode from this machine',
      (y: Argv) => y
        .option('purge', { type: 'boolean', default: false, describe: 'Also remove ~/.mudcode and installed bridge plugins' })
        .option('yes', { alias: 'y', type: 'boolean', default: false, describe: 'Skip confirmation prompt' })
        .option('skip-package-uninstall', {
          type: 'boolean',
          default: false,
          describe: 'Do not run npm/bun global uninstall commands',
        }),
      async (argv: any) =>
        uninstallCommand({
          purge: argv.purge,
          yes: argv.yes,
          skipPackageUninstall: argv.skipPackageUninstall,
        })
    )
    .parseAsync();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(chalk.red('Fatal CLI error:'), error);
    process.exit(1);
  });
}
