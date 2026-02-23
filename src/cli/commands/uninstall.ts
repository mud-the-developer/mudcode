import chalk from 'chalk';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawnSync, execSync } from 'child_process';
import { defaultDaemonManager } from '../../daemon.js';
import { removeGeminiHook } from '../../gemini/hook-installer.js';
import { confirmYesNo, isInteractiveShell } from '../common/interactive.js';

function hasCommand(command: string): boolean {
  try {
    execSync(`${command} --version`, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function removePathIfExists(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

type PackageManager = 'npm' | 'bun';

function resolveCliPackageName(): string {
  const fromEnv = process.env.DISCODE_NPM_PACKAGE?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    resolve(import.meta.dirname, '../../../package.json'),
    resolve(import.meta.dirname, '../../../../package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // Try next candidate.
    }
  }

  return '@mudramo/mudcode';
}

function uninstallViaPackageManager(manager: PackageManager, packageName: string): boolean {
  const command = manager === 'npm'
    ? ['uninstall', '-g', packageName]
    : ['remove', '-g', packageName];

  const result = spawnSync(manager, command, { stdio: 'inherit' });
  return !result.error && result.status === 0;
}

export async function uninstallCommand(options: {
  purge?: boolean;
  yes?: boolean;
  skipPackageUninstall?: boolean;
}) {
  const shouldPurge = !!options.purge;
  const skipPackageUninstall = !!options.skipPackageUninstall;
  const isInteractive = isInteractiveShell();
  const packageName = resolveCliPackageName();

  if (!options.yes && isInteractive) {
    const confirmed = await confirmYesNo(
      chalk.white('Uninstall Mudcode from this machine? [y/N]: '),
      false
    );
    if (!confirmed) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }

  console.log(chalk.cyan('\n🧹 Uninstalling Mudcode\n'));

  const running = await defaultDaemonManager.isRunning();
  if (running) {
    if (defaultDaemonManager.stopDaemon()) {
      console.log(chalk.green('✅ Daemon stopped'));
    } else {
      console.log(chalk.yellow('⚠️ Daemon appears running but could not be stopped automatically.'));
    }
  } else {
    console.log(chalk.gray('   Daemon not running'));
  }

  const localBinaryPath = join(homedir(), '.discode', 'bin', 'discode');
  if (removePathIfExists(localBinaryPath)) {
    console.log(chalk.green(`✅ Removed local binary: ${localBinaryPath}`));
  }

  if (shouldPurge) {
    const removedState = removePathIfExists(join(homedir(), '.discode'));
    const removedOpencodePlugin = removePathIfExists(join(homedir(), '.opencode', 'plugins', 'agent-opencode-bridge-plugin.ts'));
    const removedClaudePlugin = removePathIfExists(join(homedir(), '.claude', 'plugins', 'discode-claude-bridge'));
    const removedGeminiHook = removeGeminiHook();

    if (removedState) {
      console.log(chalk.green('✅ Removed ~/.discode (state/config/logs)'));
    }
    if (removedOpencodePlugin) {
      console.log(chalk.green('✅ Removed OpenCode bridge plugin'));
    }
    if (removedClaudePlugin) {
      console.log(chalk.green('✅ Removed Claude bridge plugin'));
    }
    if (removedGeminiHook) {
      console.log(chalk.green('✅ Removed Gemini bridge hook'));
    }
  }

  if (!skipPackageUninstall) {
    let packageUninstalled = false;

    if (hasCommand('npm')) {
      packageUninstalled = uninstallViaPackageManager('npm', packageName) || packageUninstalled;
    }
    if (hasCommand('bun')) {
      packageUninstalled = uninstallViaPackageManager('bun', packageName) || packageUninstalled;
    }

    if (packageUninstalled) {
      console.log(chalk.green('✅ Global package uninstall command completed'));
    } else {
      console.log(chalk.yellow('⚠️ Could not run global package uninstall automatically.'));
      console.log(chalk.gray('   Try one of:'));
      console.log(chalk.gray(`   npm uninstall -g ${packageName}`));
      console.log(chalk.gray(`   bun remove -g ${packageName}`));
    }
  }

  if (!shouldPurge) {
    console.log(chalk.gray('\nTip: use `mudcode uninstall --purge --yes` to remove config/state/plugins too.'));
  }

  console.log(chalk.cyan('\n✨ Uninstall complete\n'));
}
