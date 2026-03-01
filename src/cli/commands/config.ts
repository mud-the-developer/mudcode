import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';
import { stateManager } from '../../state/index.js';
import { config, getConfigPath, getConfigValue, saveConfig } from '../../config/index.js';
import type { StoredConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';

export async function configCommand(options: {
  show?: boolean;
  server?: string;
  token?: string;
  channel?: string;
  port?: string | number;
  defaultAgent?: string;
  opencodePermission?: 'allow' | 'default';
  promptRefinerMode?: 'off' | 'shadow' | 'enforce';
  promptRefinerLogPath?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  platform?: string;
  capturePreset?: 'default' | 'codex-final';
  capturePollMs?: string | number;
  capturePendingQuietPolls?: string | number;
  capturePendingInitialQuietPollsCodex?: string | number;
  captureCodexFinalOnly?: 'on' | 'off';
  captureStaleAlertMs?: string | number;
  captureFilterPromptEcho?: 'on' | 'off';
  capturePromptEchoMaxPolls?: string | number;
  captureHistoryLines?: string | number;
  captureRedrawTailLines?: string | number;
  longOutputThreadThreshold?: string | number;
  captureProgressOutput?: 'off' | 'thread' | 'channel';
  freeze?: boolean;
}) {
  const parseBoundedInt = (raw: string | number, label: string, min: number, max: number): number => {
    const valueRaw = String(raw).trim();
    if (!/^\d+$/.test(valueRaw)) {
      console.error(chalk.red(`Invalid ${label}: ${raw}`));
      console.log(chalk.gray(`${label} must be an integer between ${min} and ${max}.`));
      process.exit(1);
    }
    const value = parseInt(valueRaw, 10);
    if (value < min || value > max) {
      console.error(chalk.red(`Invalid ${label}: ${raw}`));
      console.log(chalk.gray(`${label} must be an integer between ${min} and ${max}.`));
      process.exit(1);
    }
    return value;
  };

  const onOffToBool = (raw: 'on' | 'off'): boolean => raw === 'on';

  if (options.freeze) {
    const frozen: Partial<StoredConfig> = {
      token: config.discord.token || undefined,
      serverId: stateManager.getGuildId() || config.discord.guildId || undefined,
      channelId: config.discord.channelId || undefined,
      hookServerPort: config.hookServerPort,
      defaultAgentCli: config.defaultAgentCli,
      opencodePermissionMode: config.opencode?.permissionMode,
      promptRefinerMode: config.promptRefiner?.mode,
      promptRefinerLogPath: config.promptRefiner?.logPath,
      promptRefinerMaxLogChars: config.promptRefiner?.maxLogChars,
      capturePollMs: config.capture?.pollMs,
      capturePendingQuietPolls: config.capture?.pendingQuietPolls,
      capturePendingInitialQuietPollsCodex: config.capture?.pendingInitialQuietPollsCodex,
      captureCodexFinalOnly: config.capture?.codexFinalOnly,
      captureStaleAlertMs: config.capture?.staleAlertMs,
      captureFilterPromptEcho: config.capture?.filterPromptEcho,
      capturePromptEchoMaxPolls: config.capture?.promptEchoMaxPolls,
      captureHistoryLines: config.capture?.historyLines,
      captureRedrawTailLines: config.capture?.redrawTailLines,
      longOutputThreadThreshold: config.capture?.longOutputThreadThreshold,
      captureProgressOutput: config.capture?.progressOutput,
      keepChannelOnStop: getConfigValue('keepChannelOnStop'),
      messagingPlatform: config.messagingPlatform,
      slackBotToken: config.slack?.botToken,
      slackAppToken: config.slack?.appToken,
    };

    saveConfig(frozen);
    console.log(chalk.green('✅ Current effective configuration was frozen into config.json'));
    console.log(chalk.gray(`   Path: ${getConfigPath()}`));
    console.log(chalk.gray('   Tip: remove stale shell env vars to avoid confusion in other tools/shells.'));
    return;
  }

  if (options.show) {
    console.log(chalk.cyan('\n📋 Current configuration:\n'));
    console.log(chalk.gray(`   Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`   Platform: ${config.messagingPlatform || 'discord'}`));
    console.log(chalk.gray(`   Server/Workspace ID: ${stateManager.getGuildId() || '(not set)'}`));
    console.log(chalk.gray(`   Discord Token: ${config.discord.token ? '****' + config.discord.token.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Default Channel ID: ${config.discord.channelId || '(not set)'}`));
    console.log(chalk.gray(`   Slack Bot Token: ${config.slack?.botToken ? '****' + config.slack.botToken.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Slack App Token: ${config.slack?.appToken ? '****' + config.slack.appToken.slice(-4) : '(not set)'}`));
    console.log(chalk.gray(`   Hook Port: ${config.hookServerPort || 18470}`));
    console.log(chalk.gray(`   Default AI CLI: ${config.defaultAgentCli || '(not set)'}`));
    console.log(chalk.gray(`   OpenCode Permission Mode: ${config.opencode?.permissionMode || '(not set)'}`));
    console.log(chalk.gray(`   Prompt Refiner Mode: ${config.promptRefiner?.mode || '(off)'}`));
    console.log(chalk.gray(`   Prompt Refiner Log Path: ${config.promptRefiner?.logPath || '(default)'}`));
    console.log(chalk.gray(`   Capture Poll Interval ms: ${config.capture?.pollMs || '(default)'}`));
    console.log(chalk.gray(`   Capture Quiet Polls: ${config.capture?.pendingQuietPolls || '(default)'}`));
    console.log(chalk.gray(`   Capture Initial Quiet Polls (Codex): ${config.capture?.pendingInitialQuietPollsCodex ?? '(default)'}`));
    console.log(chalk.gray(`   Capture Codex Final Only: ${config.capture?.codexFinalOnly === undefined ? '(default/on)' : config.capture.codexFinalOnly ? 'on' : 'off'}`));
    console.log(chalk.gray(`   Capture Stale Alert ms: ${config.capture?.staleAlertMs || '(default)'}`));
    console.log(chalk.gray(`   Capture Prompt Echo Filter: ${config.capture?.filterPromptEcho === undefined ? '(default/on)' : config.capture.filterPromptEcho ? 'on' : 'off'}`));
    console.log(chalk.gray(`   Capture Prompt Echo Max Polls: ${config.capture?.promptEchoMaxPolls || '(default)'}`));
    console.log(chalk.gray(`   Capture History Lines: ${config.capture?.historyLines || '(auto)'}`));
    console.log(chalk.gray(`   Capture Redraw Tail Lines: ${config.capture?.redrawTailLines || '(auto)'}`));
    console.log(chalk.gray(`   Long Output Thread Threshold: ${config.capture?.longOutputThreadThreshold || '(default)'}`));
    console.log(chalk.gray(`   Capture Progress Output: ${config.capture?.progressOutput || '(default/channel)'}`));
    console.log(chalk.gray(`   Keep Channel On Stop: ${getConfigValue('keepChannelOnStop') ? 'on' : 'off'}`));
    console.log(chalk.cyan('\n🤖 Registered Agents:\n'));
    for (const adapter of agentRegistry.getAll()) {
      console.log(chalk.gray(`   - ${adapter.config.displayName} (${adapter.config.name})`));
    }
    console.log('');
    return;
  }

  let updated = false;

  if (options.platform) {
    const platform = options.platform === 'slack' ? 'slack' : 'discord';
    saveConfig({ messagingPlatform: platform });
    console.log(chalk.green(`✅ Platform saved: ${platform}`));
    updated = true;
  }

  if (options.server) {
    stateManager.setGuildId(options.server);
    saveConfig({ serverId: options.server });
    console.log(chalk.green(`✅ Server ID saved: ${options.server}`));
    updated = true;
  }

  if (options.token) {
    const token = normalizeDiscordToken(options.token);
    if (!token) {
      console.error(chalk.red('Invalid bot token input.'));
      process.exit(1);
    }
    saveConfig({ token });
    console.log(chalk.green(`✅ Bot token saved (****${token.slice(-4)})`));
    updated = true;
  }

  if (options.channel !== undefined) {
    const channel = options.channel.trim();
    if (!channel) {
      saveConfig({ channelId: undefined });
      console.log(chalk.green('✅ Default channel cleared'));
    } else {
      const normalized = channel.replace(/^<#(\d+)>$/, '$1');
      saveConfig({ channelId: normalized });
      console.log(chalk.green(`✅ Default channel saved: ${normalized}`));
    }
    updated = true;
  }

  if (options.slackBotToken) {
    saveConfig({ slackBotToken: options.slackBotToken });
    console.log(chalk.green(`✅ Slack bot token saved (****${options.slackBotToken.slice(-4)})`));
    updated = true;
  }

  if (options.slackAppToken) {
    saveConfig({ slackAppToken: options.slackAppToken });
    console.log(chalk.green(`✅ Slack app token saved (****${options.slackAppToken.slice(-4)})`));
    updated = true;
  }

  if (options.port) {
    const portRaw = String(options.port).trim();
    if (!/^\d+$/.test(portRaw)) {
      console.error(chalk.red(`Invalid hook port: ${options.port}`));
      console.log(chalk.gray('Hook port must be an integer between 1 and 65535.'));
      process.exit(1);
    }
    const port = parseInt(portRaw, 10);
    if (port < 1 || port > 65535) {
      console.error(chalk.red(`Invalid hook port: ${options.port}`));
      console.log(chalk.gray('Hook port must be an integer between 1 and 65535.'));
      process.exit(1);
    }
    saveConfig({ hookServerPort: port });
    console.log(chalk.green(`✅ Hook port saved: ${port}`));
    updated = true;
  }

  if (options.defaultAgent) {
    const normalized = options.defaultAgent.trim().toLowerCase();
    const adapter = agentRegistry.get(normalized);
    if (!adapter) {
      console.error(chalk.red(`Unknown agent: ${options.defaultAgent}`));
      console.log(chalk.gray(`Available agents: ${agentRegistry.getAll().map((a) => a.config.name).join(', ')}`));
      process.exit(1);
    }
    saveConfig({ defaultAgentCli: adapter.config.name });
    console.log(chalk.green(`✅ Default AI CLI saved: ${adapter.config.name}`));
    updated = true;
  }

  if (options.opencodePermission) {
    saveConfig({ opencodePermissionMode: options.opencodePermission });
    console.log(chalk.green(`✅ OpenCode permission mode saved: ${options.opencodePermission}`));
    updated = true;
  }

  if (options.promptRefinerMode) {
    saveConfig({ promptRefinerMode: options.promptRefinerMode });
    console.log(chalk.green(`✅ Prompt refiner mode saved: ${options.promptRefinerMode}`));
    updated = true;
  }

  if (options.promptRefinerLogPath !== undefined) {
    const path = options.promptRefinerLogPath.trim();
    if (!path || path.toLowerCase() === 'default') {
      saveConfig({ promptRefinerLogPath: undefined });
      console.log(chalk.green('✅ Prompt refiner log path reset to default'));
    } else {
      saveConfig({ promptRefinerLogPath: path });
      console.log(chalk.green(`✅ Prompt refiner log path saved: ${path}`));
    }
    updated = true;
  }

  if (options.capturePreset) {
    if (options.capturePreset === 'default') {
      saveConfig({
        capturePollMs: undefined,
        capturePendingQuietPolls: undefined,
        capturePendingInitialQuietPollsCodex: undefined,
        captureCodexFinalOnly: undefined,
        captureStaleAlertMs: undefined,
        captureFilterPromptEcho: undefined,
        capturePromptEchoMaxPolls: undefined,
        captureHistoryLines: undefined,
        captureRedrawTailLines: undefined,
        longOutputThreadThreshold: undefined,
        captureProgressOutput: undefined,
      });
      console.log(chalk.green('✅ Capture preset applied: default'));
    } else if (options.capturePreset === 'codex-final') {
      saveConfig({
        captureCodexFinalOnly: true,
        captureFilterPromptEcho: true,
        capturePromptEchoMaxPolls: 2,
        capturePendingInitialQuietPollsCodex: 0,
        captureProgressOutput: 'thread',
      });
      console.log(chalk.green('✅ Capture preset applied: codex-final'));
    }
    updated = true;
  }

  if (options.capturePollMs !== undefined) {
    const value = parseBoundedInt(options.capturePollMs, 'capture poll ms', 250, 60000);
    saveConfig({ capturePollMs: value });
    console.log(chalk.green(`✅ Capture poll interval saved: ${value}ms`));
    updated = true;
  }

  if (options.capturePendingQuietPolls !== undefined) {
    const value = parseBoundedInt(options.capturePendingQuietPolls, 'capture pending quiet polls', 1, 20);
    saveConfig({ capturePendingQuietPolls: value });
    console.log(chalk.green(`✅ Capture pending quiet polls saved: ${value}`));
    updated = true;
  }

  if (options.capturePendingInitialQuietPollsCodex !== undefined) {
    const value = parseBoundedInt(
      options.capturePendingInitialQuietPollsCodex,
      'capture pending initial quiet polls (codex)',
      0,
      20,
    );
    saveConfig({ capturePendingInitialQuietPollsCodex: value });
    console.log(chalk.green(`✅ Capture pending initial quiet polls (codex) saved: ${value}`));
    updated = true;
  }

  if (options.captureCodexFinalOnly !== undefined) {
    const value = onOffToBool(options.captureCodexFinalOnly);
    saveConfig({ captureCodexFinalOnly: value });
    console.log(chalk.green(`✅ Capture codex final-only saved: ${value ? 'on' : 'off'}`));
    updated = true;
  }

  if (options.captureStaleAlertMs !== undefined) {
    const value = parseBoundedInt(options.captureStaleAlertMs, 'capture stale alert ms', 1000, 3600000);
    saveConfig({ captureStaleAlertMs: value });
    console.log(chalk.green(`✅ Capture stale alert saved: ${value}ms`));
    updated = true;
  }

  if (options.captureFilterPromptEcho !== undefined) {
    const value = onOffToBool(options.captureFilterPromptEcho);
    saveConfig({ captureFilterPromptEcho: value });
    console.log(chalk.green(`✅ Capture prompt-echo filter saved: ${value ? 'on' : 'off'}`));
    updated = true;
  }

  if (options.capturePromptEchoMaxPolls !== undefined) {
    const value = parseBoundedInt(options.capturePromptEchoMaxPolls, 'capture prompt echo max polls', 1, 20);
    saveConfig({ capturePromptEchoMaxPolls: value });
    console.log(chalk.green(`✅ Capture prompt-echo max polls saved: ${value}`));
    updated = true;
  }

  if (options.captureHistoryLines !== undefined) {
    const value = parseBoundedInt(options.captureHistoryLines, 'capture history lines', 300, 4000);
    saveConfig({ captureHistoryLines: value });
    console.log(chalk.green(`✅ Capture history lines saved: ${value}`));
    updated = true;
  }

  if (options.captureRedrawTailLines !== undefined) {
    const value = parseBoundedInt(options.captureRedrawTailLines, 'capture redraw tail lines', 40, 300);
    saveConfig({ captureRedrawTailLines: value });
    console.log(chalk.green(`✅ Capture redraw tail lines saved: ${value}`));
    updated = true;
  }

  if (options.longOutputThreadThreshold !== undefined) {
    const value = parseBoundedInt(options.longOutputThreadThreshold, 'long output thread threshold', 1200, 20000);
    saveConfig({ longOutputThreadThreshold: value });
    console.log(chalk.green(`✅ Long output thread threshold saved: ${value}`));
    updated = true;
  }

  if (options.captureProgressOutput !== undefined) {
    saveConfig({ captureProgressOutput: options.captureProgressOutput });
    console.log(chalk.green(`✅ Capture progress output saved: ${options.captureProgressOutput}`));
    updated = true;
  }

  if (!updated) {
    console.log(chalk.yellow('No options provided. Use --help to see available options.'));
    console.log(chalk.gray('\nExample:'));
    console.log(chalk.gray('  mudcode config --token YOUR_BOT_TOKEN'));
    console.log(chalk.gray('  mudcode config --server YOUR_SERVER_ID'));
    console.log(chalk.gray('  mudcode config --channel 123456789012345678'));
    console.log(chalk.gray('  mudcode config --default-agent claude'));
    console.log(chalk.gray('  mudcode config --platform slack'));
    console.log(chalk.gray('  mudcode config --slack-bot-token xoxb-...'));
    console.log(chalk.gray('  mudcode config --slack-app-token xapp-...'));
    console.log(chalk.gray('  mudcode config --opencode-permission allow'));
    console.log(chalk.gray('  mudcode config --prompt-refiner-mode shadow'));
    console.log(chalk.gray('  mudcode config --prompt-refiner-log-path ~/.mudcode/prompt-refiner-shadow.jsonl'));
    console.log(chalk.gray('  mudcode config --capture-preset codex-final'));
    console.log(chalk.gray('  mudcode config --capture-codex-final-only on'));
    console.log(chalk.gray('  mudcode config --capture-progress-output thread'));
    console.log(chalk.gray('  mudcode config --capture-filter-prompt-echo on'));
    console.log(chalk.gray('  mudcode config --show'));
  }
}
