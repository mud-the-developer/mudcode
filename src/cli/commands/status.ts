import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath } from '../../config/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances } from '../../state/instances.js';
import { agentRegistry } from '../../agents/index.js';
import { getDaemonStatus } from '../../app/daemon-service.js';
import type { TmuxCliOptions } from '../common/types.js';
import { applyTmuxCliOverrides } from '../common/tmux.js';

export async function statusCommand(options: TmuxCliOptions) {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const projects = stateManager.listProjects();
  const tmux = new TmuxManager(effectiveConfig.tmux.sessionPrefix);
  const sessions = tmux.listSessions();
  const daemonStatus = await getDaemonStatus().catch(() => undefined);

  console.log(chalk.cyan('\n📊 Mudcode Status\n'));

  console.log(chalk.white('Configuration:'));
  console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
  console.log(chalk.gray(`   Server ID: ${stateManager.getGuildId() || '(not configured)'}`));
  console.log(chalk.gray(`   Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
  console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
  if (daemonStatus) {
    console.log(
      chalk.gray(
        `   Daemon: ${daemonStatus.running ? `running on ${daemonStatus.port}` : `not running (expected port ${daemonStatus.port})`}`,
      ),
    );
  }

  console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
  for (const adapter of agentRegistry.getAll()) {
    console.log(chalk.gray(`   ${adapter.config.displayName} (${adapter.config.command})`));
  }

  console.log(chalk.cyan('\n📂 Projects:\n'));

  if (projects.length === 0) {
    console.log(chalk.gray('   No projects configured. Run `mudcode new` in a project directory.'));
  } else {
    for (const project of projects) {
      const sessionActive = sessions.some((s) => s.name === project.tmuxSession);
      const status = sessionActive ? chalk.green('● active') : chalk.gray('○ inactive');

      console.log(chalk.white(`   ${project.projectName}`), status);
      console.log(chalk.gray(`     Path: ${project.projectPath}`));

      const instances = listProjectInstances(project);
      const labels = instances.map((instance) => {
        const agentLabel = agentRegistry.get(instance.agentType)?.config.displayName || instance.agentType;
        return `${agentLabel}#${instance.instanceId}`;
      });
      console.log(chalk.gray(`     Instances: ${labels.length > 0 ? labels.join(', ') : 'none'}`));
      console.log('');
    }
  }

  console.log(chalk.cyan('📺 tmux Sessions:\n'));
  if (sessions.length === 0) {
    console.log(chalk.gray('   No active sessions'));
  } else {
    for (const session of sessions) {
      console.log(chalk.white(`   ${session.name}`), chalk.gray(`(${session.windows} windows)`));
    }
  }
  console.log(chalk.gray('   Tip: run `mudcode health` for full diagnostics.'));
  console.log('');
}
