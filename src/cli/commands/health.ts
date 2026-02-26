import chalk from 'chalk';
import { config, getConfigPath, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { listProjectInstances } from '../../state/instances.js';
import { TmuxManager } from '../../tmux/manager.js';
import { getDaemonStatus } from '../../app/daemon-service.js';
import { resolveProjectWindowName } from '../../policy/window-naming.js';
import { applyTmuxCliOverrides } from '../common/tmux.js';
import type { TmuxCliOptions } from '../common/types.js';

type HealthLevel = 'ok' | 'warn' | 'fail';

type HealthCheck = {
  name: string;
  level: HealthLevel;
  detail: string;
};

type InstanceHealth = {
  projectName: string;
  instanceId: string;
  agentType: string;
  tmuxSession: string;
  tmuxWindow: string;
  sessionExists: boolean;
  windowExists: boolean;
  channelId: string | undefined;
};

function pushCheck(checks: HealthCheck[], name: string, level: HealthLevel, detail: string): void {
  checks.push({ name, level, detail });
}

export async function healthCommand(options: TmuxCliOptions & { json?: boolean } = {}): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);

  const checks: HealthCheck[] = [];
  const instances: InstanceHealth[] = [];

  try {
    validateConfig();
    pushCheck(checks, 'config', 'ok', `config valid (${getConfigPath()})`);
  } catch (error) {
    pushCheck(
      checks,
      'config',
      'fail',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const daemon = await getDaemonStatus();
    const daemonDetail = daemon.running
      ? `running on ${daemon.port} (pid file: ${daemon.pidFile})`
      : `not running (expected port ${daemon.port}, pid file: ${daemon.pidFile})`;
    pushCheck(checks, 'daemon', daemon.running ? 'ok' : 'warn', daemonDetail);
  } catch (error) {
    pushCheck(checks, 'daemon', 'fail', error instanceof Error ? error.message : String(error));
  }

  const projects = stateManager.listProjects();
  if (projects.length === 0) {
    pushCheck(checks, 'projects', 'warn', 'no configured projects');
  } else {
    pushCheck(checks, 'projects', 'ok', `${projects.length} configured project(s)`);
  }

  for (const project of projects) {
    const sessionExists = tmux.sessionExistsFull(project.tmuxSession);
    if (!sessionExists) {
      pushCheck(
        checks,
        `tmux:${project.projectName}`,
        'warn',
        `session missing: ${project.tmuxSession}`,
      );
    }

    const projectInstances = listProjectInstances(project);
    if (projectInstances.length === 0) {
      pushCheck(checks, `project:${project.projectName}`, 'warn', 'no agent instances');
      continue;
    }

    for (const instance of projectInstances) {
      const windowName = resolveProjectWindowName(
        project,
        instance.agentType,
        effectiveConfig.tmux,
        instance.instanceId,
      );
      const windowExists = sessionExists && tmux.windowExists(project.tmuxSession, windowName);
      const channelId = instance.channelId;
      instances.push({
        projectName: project.projectName,
        instanceId: instance.instanceId,
        agentType: instance.agentType,
        tmuxSession: project.tmuxSession,
        tmuxWindow: windowName,
        sessionExists,
        windowExists,
        channelId,
      });

      if (!windowExists) {
        pushCheck(
          checks,
          `instance:${project.projectName}/${instance.instanceId}`,
          'warn',
          `tmux window missing: ${project.tmuxSession}:${windowName}`,
        );
      }
      if (!channelId) {
        pushCheck(
          checks,
          `instance:${project.projectName}/${instance.instanceId}`,
          'fail',
          'channel mapping missing',
        );
      }
    }
  }

  const summary = {
    ok: checks.filter((check) => check.level === 'ok').length,
    warn: checks.filter((check) => check.level === 'warn').length,
    fail: checks.filter((check) => check.level === 'fail').length,
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary,
          checks,
          instances,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(chalk.cyan('\n🩺 Mudcode Health\n'));
    console.log(chalk.gray(`Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`Platform: ${effectiveConfig.messagingPlatform || 'discord'}`));
    console.log(chalk.gray(`Hook port: ${effectiveConfig.hookServerPort || 18470}`));
    console.log('');

    for (const check of checks) {
      const icon = check.level === 'ok' ? '✅' : check.level === 'warn' ? '⚠️' : '❌';
      const color = check.level === 'ok' ? chalk.green : check.level === 'warn' ? chalk.yellow : chalk.red;
      console.log(color(`${icon} ${check.name}: ${check.detail}`));
    }

    if (instances.length > 0) {
      console.log(chalk.cyan('\nInstances:\n'));
      for (const instance of instances) {
        const tmuxStatus = instance.windowExists ? chalk.green('ok') : chalk.yellow('missing');
        const channelStatus = instance.channelId ? chalk.green('ok') : chalk.red('missing');
        console.log(
          chalk.gray(
            `- ${instance.projectName}/${instance.instanceId} (${instance.agentType})`,
          ),
        );
        console.log(
          chalk.gray(`    tmux: ${instance.tmuxSession}:${instance.tmuxWindow} (${tmuxStatus})`),
        );
        console.log(
          chalk.gray(`    channel: ${instance.channelId || '(none)'} (${channelStatus})`),
        );
      }
      console.log('');
    }

    const summaryColor =
      summary.fail > 0 ? chalk.red : summary.warn > 0 ? chalk.yellow : chalk.green;
    console.log(summaryColor(`Summary: ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`));
    console.log('');
  }

  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}
