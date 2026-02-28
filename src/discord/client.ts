/**
 * Discord client setup and management
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  AttachmentBuilder,
  ApplicationCommandOptionType,
} from 'discord.js';
import type { AgentMessage, MessageAttachment } from '../types/index.js';
import { agentRegistry as defaultAgentRegistry, type AgentConfig, type AgentRegistry } from '../agents/index.js';
import { normalizeDiscordToken } from '../config/token.js';
import type { MessagingClient, MessageCallback, ChannelInfo, MessageContext } from '../messaging/interface.js';
import { splitForDiscord } from '../capture/parser.js';

export type { MessageCallback, ChannelInfo };

const CONTROL_BUTTON_PREFIX = 'mudcode:control:';
const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;
const DEFAULT_DISCORD_SEND_MAX_RETRIES = 2;
const DISCORD_SEND_BASE_BACKOFF_MS = 600;
const DISCORD_SEND_MAX_BACKOFF_MS = 10000;
const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export class DiscordClient implements MessagingClient {
  readonly platform = 'discord' as const;
  private client: Client;
  private token: string;
  private targetChannel?: TextChannel;
  private messageCallback?: MessageCallback;
  private channelMapping: Map<string, ChannelInfo> = new Map();
  private typingIndicators: Map<string, { timer: ReturnType<typeof setInterval>; refs: number }> = new Map();
  private sendQueues: Map<string, Promise<void>> = new Map();
  private registry: AgentRegistry;

  constructor(token: string, registry?: AgentRegistry) {
    this.token = normalizeDiscordToken(token);
    this.registry = registry || defaultAgentRegistry;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('clientReady', async () => {
      console.log(`Discord bot logged in as ${this.client.user?.tag}`);
      if (this.shouldScanExistingChannels()) {
        this.scanExistingChannels();
      }
      await this.registerSessionControlCommands();
    });

    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
    });

    this.client.on('messageCreate', async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Only process text channels
      if (!message.channel.isTextBased()) return;

      const route = this.resolveRouteForIncomingMessage(message.channelId, message.channel as unknown);
      if (route && this.messageCallback) {
        const { channelInfo, routeChannelId, threadId } = route;
        try {
          // Extract attachments from the Discord message
          const attachments: MessageAttachment[] = message.attachments.map((a) => ({
            url: a.url,
            filename: a.name ?? 'unknown',
            contentType: a.contentType,
            size: a.size,
          }));
          const context = this.buildMessageContext({
            sourceChannelId: message.channelId,
            routeChannelId,
            authorId: message.author.id,
            threadId,
            replyToMessageId: message.reference?.messageId || undefined,
          });

          await this.messageCallback(
            channelInfo.agentType,
            message.content,
            channelInfo.projectName,
            message.channelId,
            message.id,
            channelInfo.instanceId,
            attachments.length > 0 ? attachments : undefined,
            context,
          );
        } catch (error) {
          console.error(
            `Discord message handler error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${message.channelId}:`,
            error
          );
        }
      }
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.user?.bot) return;

      if (interaction.isButton()) {
        await this.handleControlButtonInteraction(interaction);
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      const commandName = interaction.commandName.toLowerCase();
      const sessionCommands = new Set(['q', 'qw']);
      const keyCommands = new Set(['enter', 'tab', 'esc', 'up', 'down']);
      const utilityCommands = new Set(['retry', 'health', 'snapshot', 'io']);
      const panelCommands = new Set(['controls']);
      if (
        !sessionCommands.has(commandName) &&
        !keyCommands.has(commandName) &&
        !utilityCommands.has(commandName) &&
        !panelCommands.has(commandName)
      ) {
        return;
      }

      const route = this.resolveRouteForIncomingMessage(interaction.channelId, interaction.channel as unknown);
      if (!route || !this.messageCallback) {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({
            content: '⚠️ This channel is not mapped to an active agent instance.',
            ephemeral: true,
          });
        }
        return;
      }

      if (commandName === 'controls') {
        try {
          await interaction.deferReply({ ephemeral: true });
          const posted = await this.sendControlPanelToChannel(interaction.channelId);
          if (posted) {
            await interaction.editReply('✅ Control panel posted.');
          } else {
            await interaction.editReply('⚠️ Could not post control panel in this channel.');
          }
        } catch (error) {
          console.error(
            `Discord controls command error [${route.channelInfo.projectName}/${route.channelInfo.agentType}] channel=${interaction.channelId}:`,
            error,
          );
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply('⚠️ Failed to post control panel. Try again.').catch(() => {});
          } else {
            await interaction.reply({ content: '⚠️ Failed to post control panel. Try again.', ephemeral: true }).catch(() => {});
          }
        }
        return;
      }

      const { channelInfo, routeChannelId, threadId } = route;
      const context = this.buildMessageContext({
        sourceChannelId: interaction.channelId,
        routeChannelId,
        authorId: interaction.user.id,
        threadId,
      });
      const count = keyCommands.has(commandName) ? interaction.options.getInteger('count') || 1 : 1;
      const commandPayload =
        keyCommands.has(commandName) && count > 1
          ? `/${commandName} ${count}`
          : `/${commandName}`;

      try {
        await interaction.deferReply({ ephemeral: true });
        await this.messageCallback(
          channelInfo.agentType,
          commandPayload,
          channelInfo.projectName,
          interaction.channelId,
          undefined,
          channelInfo.instanceId,
          undefined,
          context,
        );
        await interaction.editReply(`✅ \`${commandPayload}\` request submitted.`);
      } catch (error) {
        console.error(
          `Discord slash command error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${interaction.channelId}:`,
          error,
        );
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply('⚠️ Failed to process the command. Try again.').catch(() => {});
        } else {
          await interaction.reply({
            content: '⚠️ Failed to process the command. Try again.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
    });
  }

  private controlCommandFromButtonId(customId: string): string | null {
    if (!customId.startsWith(CONTROL_BUTTON_PREFIX)) return null;
    const action = customId.slice(CONTROL_BUTTON_PREFIX.length);
    switch (action) {
      case 'retry':
        return '/retry';
      case 'enter':
        return '/enter';
      case 'esc':
        return '/esc';
      case 'q':
        return '/q';
      case 'qw':
        return '/qw';
      default:
        return null;
    }
  }

  private buildControlPanelRows(): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTROL_BUTTON_PREFIX}retry`)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_BUTTON_PREFIX}enter`)
        .setLabel('Enter')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_BUTTON_PREFIX}esc`)
        .setLabel('Esc')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_BUTTON_PREFIX}q`)
        .setLabel('Close')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_BUTTON_PREFIX}qw`)
        .setLabel('Archive')
        .setStyle(ButtonStyle.Success),
    );

    return [row];
  }

  private async sendControlPanelToChannel(channelId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;

      await (channel as TextChannel).send({
        content:
          '🎛️ **Mudcode Controls**\n' +
          'Use these quick actions for the mapped agent in this channel.',
        components: this.buildControlPanelRows(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async handleControlButtonInteraction(interaction: any): Promise<void> {
    const commandPayload = this.controlCommandFromButtonId(String(interaction.customId || ''));
    if (!commandPayload) return;

    if (!this.messageCallback) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: '⚠️ Bridge callback is not ready. Try again in a moment.',
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    const route = this.resolveRouteForIncomingMessage(interaction.channelId, interaction.channel as unknown);
    if (!route) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.reply({
          content: '⚠️ This channel is not mapped to an active agent instance.',
          ephemeral: true,
        }).catch(() => {});
      }
      return;
    }

    const { channelInfo, routeChannelId, threadId } = route;
    const context = this.buildMessageContext({
      sourceChannelId: interaction.channelId,
      routeChannelId,
      authorId: interaction.user.id,
      threadId,
    });

    try {
      await interaction.deferReply({ ephemeral: true });
      await this.messageCallback(
        channelInfo.agentType,
        commandPayload,
        channelInfo.projectName,
        interaction.channelId,
        undefined,
        channelInfo.instanceId,
        undefined,
        context,
      );
      await interaction.editReply(`✅ \`${commandPayload}\` request submitted.`);
    } catch (error) {
      console.error(
        `Discord control button error [${channelInfo.projectName}/${channelInfo.agentType}] channel=${interaction.channelId}:`,
        error,
      );
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('⚠️ Failed to process the control action. Try again.').catch(() => {});
      } else {
        await interaction.reply({
          content: '⚠️ Failed to process the control action. Try again.',
          ephemeral: true,
        }).catch(() => {});
      }
    }
  }

  private async registerSessionControlCommands(): Promise<void> {
    const commands = [
      {
        name: 'q',
        description: 'Stop the current agent pane and delete this channel.',
      },
      {
        name: 'qw',
        description: 'Stop the current agent pane and save this channel.',
      },
      {
        name: 'retry',
        description: 'Resend the last prompt for the active agent instance.',
      },
      {
        name: 'health',
        description: 'Show bridge/session health for this mapped instance.',
      },
      {
        name: 'snapshot',
        description: 'Post the current tmux pane snapshot for this instance.',
      },
      {
        name: 'io',
        description: 'Show codex I/O tracker status for this instance.',
      },
      {
        name: 'controls',
        description: 'Post a button control panel in this channel.',
      },
      {
        name: 'enter',
        description: 'Send Enter key to the active agent pane.',
        options: [
          {
            name: 'count',
            description: 'How many times to send Enter (1-20).',
            type: ApplicationCommandOptionType.Integer,
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
      {
        name: 'tab',
        description: 'Send Tab key to the active agent pane.',
        options: [
          {
            name: 'count',
            description: 'How many times to send Tab (1-20).',
            type: ApplicationCommandOptionType.Integer,
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
      {
        name: 'esc',
        description: 'Send Escape key to the active agent pane.',
        options: [
          {
            name: 'count',
            description: 'How many times to send Escape (1-20).',
            type: ApplicationCommandOptionType.Integer,
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
      {
        name: 'up',
        description: 'Send Up Arrow key to the active agent pane.',
        options: [
          {
            name: 'count',
            description: 'How many times to send Up Arrow (1-20).',
            type: ApplicationCommandOptionType.Integer,
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
      {
        name: 'down',
        description: 'Send Down Arrow key to the active agent pane.',
        options: [
          {
            name: 'count',
            description: 'How many times to send Down Arrow (1-20).',
            type: ApplicationCommandOptionType.Integer,
            required: false,
            min_value: 1,
            max_value: 20,
          },
        ],
      },
    ] as const;

    const guildsToRegister = new Map<string, any>();
    for (const guild of this.client.guilds.cache.values()) {
      guildsToRegister.set(guild.id, guild);
    }

    if (guildsToRegister.size === 0) {
      try {
        const fetchedGuilds = await this.client.guilds.fetch();
        for (const entry of fetchedGuilds.values()) {
          const guild = await entry.fetch();
          guildsToRegister.set(guild.id, guild);
        }
      } catch (error) {
        console.warn('Failed to fetch guilds for slash command registration:', error);
      }
    }

    if (guildsToRegister.size === 0) {
      console.warn('No guilds available for slash command registration.');
      return;
    }

    for (const guild of guildsToRegister.values()) {
      try {
        await guild.commands.set(commands);
      } catch (error) {
        console.warn(`Failed to register slash commands for guild ${guild.id}:`, error);
      }
    }
  }

  private resolveRouteForIncomingMessage(
    sourceChannelId: string,
    channel: unknown,
  ): { channelInfo: ChannelInfo; routeChannelId: string; threadId?: string } | null {
    const direct = this.channelMapping.get(sourceChannelId);
    if (direct) {
      return {
        channelInfo: direct,
        routeChannelId: sourceChannelId,
      };
    }

    const threadLike = channel as { isThread?: () => boolean; parentId?: string };
    const isThread = typeof threadLike?.isThread === 'function' && threadLike.isThread();
    const parentId = isThread ? threadLike.parentId : undefined;
    if (!parentId) return null;

    const parentMapping = this.channelMapping.get(parentId);
    if (!parentMapping) return null;

    return {
      channelInfo: parentMapping,
      routeChannelId: parentId,
      threadId: sourceChannelId,
    };
  }

  private buildMessageContext(input: {
    sourceChannelId: string;
    routeChannelId: string;
    authorId: string;
    threadId?: string;
    replyToMessageId?: string;
  }): MessageContext {
    const conversationKey = input.threadId
      ? `discord:thread:${input.threadId}`
      : `discord:channel:${input.routeChannelId}:author:${input.authorId}`;

    return {
      platform: 'discord',
      sourceChannelId: input.sourceChannelId,
      routeChannelId: input.routeChannelId,
      authorId: input.authorId,
      threadId: input.threadId,
      replyToMessageId: input.replyToMessageId,
      conversationKey,
    };
  }

  private scanExistingChannels(): void {
    this.client.guilds.cache.forEach((guild) => {
      guild.channels.cache.forEach((channel) => {
        if (channel.isTextBased() && channel.name) {
          const parsed = this.parseChannelName(channel.name);
          if (parsed) {
            this.channelMapping.set(channel.id, parsed);
            console.log(`Mapped channel ${channel.name} (${channel.id}) -> ${parsed.projectName}:${parsed.agentType}`);
          }
        }
      });
    });
  }

  private parseChannelName(channelName: string): ChannelInfo | null {
    // Use agent registry to parse channel names dynamically
    const result = this.registry.parseChannelName(channelName);
    if (result) {
      return {
        projectName: result.projectName,
        agentType: result.agent.config.name,
      };
    }
    return null;
  }

  private normalizeChannelName(name: string, maxLength: number = 100): string {
    const normalized = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');

    const clipped = normalized.slice(0, maxLength).replace(/^[-_]+|[-_]+$/g, '');
    return clipped.length > 0 ? clipped : 'saved-channel';
  }

  private buildSavedChannelName(currentName: string, now: Date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return this.normalizeChannelName(`saved_${timestamp}_${currentName}`, 100);
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error(
        'Discord login failed: bot token is empty. Run `mudcode config --token <your-token>` or `mudcode onboard`.'
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord login timed out after 30 seconds'));
      }, 30000);

      this.client.once('clientReady', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.login(this.token).catch((error) => {
        clearTimeout(timeout);
        const rawMessage = error instanceof Error ? error.message : String(error);
        if (/invalid token/i.test(rawMessage)) {
          reject(
            new Error(
              'Discord login failed: invalid bot token. Run `mudcode config --token <your-token>` or `mudcode onboard`.'
            )
          );
          return;
        }
        reject(new Error(`Discord login failed: ${rawMessage}`));
      });
    });
  }

  async setTargetChannel(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    this.targetChannel = channel as TextChannel;
  }

  async sendMessage(message: AgentMessage): Promise<void> {
    if (!this.targetChannel) {
      console.warn('No target channel set, skipping message');
      return;
    }

    const formatted = this.formatMessage(message);
    await this.targetChannel.send(formatted);
  }

  private formatMessage(message: AgentMessage): string {
    const emoji = this.getEmojiForType(message.type);
    const header = `${emoji} **${message.type}** ${message.agentName ? `(${message.agentName})` : ''}`;

    return `${header}\n${message.content}`;
  }

  private getEmojiForType(type: AgentMessage['type']): string {
    switch (type) {
      case 'tool-output':
        return '🔧';
      case 'agent-output':
        return '🤖';
      case 'error':
        return '❌';
      default:
        return '📝';
    }
  }

  /**
   * Send a tool approval request to a channel and wait for user reaction
   * @returns true if approved, false if denied
   */
  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs: number = 120000
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.warn(`Channel ${channelId} is not a text channel, auto-denying`);
      return false;
    }

    const textChannel = channel as TextChannel;

    // Format the approval message
    let inputPreview = '';
    if (toolInput) {
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
      inputPreview = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;
    }

    const message = await textChannel.send(
      `🔒 **Permission Request**\n` +
      `Tool: \`${toolName}\`\n` +
      `\`\`\`\n${inputPreview}\n\`\`\`\n` +
      `React ✅ to allow, ❌ to deny (${Math.round(timeoutMs / 1000)}s timeout, auto-deny on timeout)`
    );

    await message.react('✅');
    await message.react('❌');

    try {
      const collected = await message.awaitReactions({
        filter: (reaction, user) =>
          ['✅', '❌'].includes(reaction.emoji.name || '') && !user.bot,
        max: 1,
        time: timeoutMs,
      });

      if (collected.size === 0) {
        await message.edit(message.content + '\n\n⏰ **Timed out — auto-denied**');
        return false;
      }

      const approved = collected.first()?.emoji.name === '✅';
      await message.edit(
        message.content + `\n\n${approved ? '✅ **Allowed**' : '❌ **Denied**'}`
      );
      return approved;
    } catch {
      // On error, default to deny for security
      await message.edit(message.content + '\n\n⚠️ **Error — auto-denied**').catch(() => {});
      return false;
    }
  }

  async disconnect(): Promise<void> {
    for (const state of this.typingIndicators.values()) {
      clearInterval(state.timer);
    }
    this.typingIndicators.clear();
    await this.client.destroy();
  }

  /**
   * Register a callback to handle incoming messages from Discord channels
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Create agent channels for a project in a guild
   * @param guildId - Discord guild ID
   * @param projectName - Project name
   * @param agentConfigs - Array of agent configurations to create channels for
   * @param customChannelName - Optional custom channel name (e.g., "Claude - 내 프로젝트")
   * @returns Object mapping agent names to channel IDs
   */
  async createAgentChannels(
    guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not found`);
    }

    const result: { [agentName: string]: string } = {};

    // Fetch all channels in the guild so we can check for existing ones
    const allChannels = await guild.channels.fetch();

    for (const config of agentConfigs) {
      // Use custom channel name if provided, otherwise use default format
      const channelName = customChannelName || `${projectName}-${config.channelSuffix}`;

      // Discord normalizes channel names to lowercase with hyphens replacing spaces
      const normalized = channelName.toLowerCase().replace(/\s+/g, '-');

      // Look for an existing text channel with the same name
      const existing = allChannels.find(
        (ch) => ch !== null && ch.type === ChannelType.GuildText && ch.name === normalized
      );

      let channel: TextChannel;
      if (existing) {
        channel = existing as TextChannel;
        console.log(`  - ${config.displayName}: reusing existing channel ${channel.name} (${channel.id})`);
      } else {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: `${config.displayName} agent for ${projectName}`,
        });
        console.log(`  - ${config.displayName}: created channel ${channel.name} (${channel.id})`);
      }

      // Register in mapping
      this.channelMapping.set(channel.id, {
        projectName,
        agentType: config.name,
        instanceId: instanceIdByAgent?.[config.name],
      });

      result[config.name] = channel.id;
    }

    console.log(`Set up ${agentConfigs.length} channels for project ${projectName}`);
    return result;
  }

  /**
   * Register channel mappings from external source (e.g., state file)
   */
  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    // Keep routing strict: state-provided mappings are authoritative.
    this.channelMapping.clear();
    for (const m of mappings) {
      this.channelMapping.set(m.channelId, {
        projectName: m.projectName,
        agentType: m.agentType,
        instanceId: m.instanceId,
      });
      console.log(
        `Registered channel ${m.channelId} -> ${m.projectName}:${m.agentType}${m.instanceId ? `#${m.instanceId}` : ''}`,
      );
    }
  }

  /**
   * Get list of guilds the bot is in
   */
  getGuilds(): { id: string; name: string }[] {
    return this.client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
    }));
  }

  /**
   * Get the current channel mapping
   */
  getChannelMapping(): Map<string, ChannelInfo> {
    return new Map(this.channelMapping);
  }

  /**
   * Delete a Discord channel by ID
   */
  async deleteChannel(channelId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).delete();
        this.channelMapping.delete(channelId);
        return true;
      }
      return false;
    } catch (error: any) {
      // 10003 = Unknown Channel (already deleted), just log briefly
      if (error?.code === 10003) {
        console.log(`Channel ${channelId} already deleted`);
      } else {
        console.error(`Failed to delete channel ${channelId}:`, error);
      }
      return false;
    }
  }

  async archiveChannel(channelId: string): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return null;

      const hasSetName = 'setName' in channel && typeof (channel as any).setName === 'function';
      if (!hasSetName) return null;

      const currentName =
        'name' in channel && typeof (channel as any).name === 'string'
          ? (channel as any).name
          : 'channel';
      const savedName = this.buildSavedChannelName(currentName);
      await (channel as any).setName(savedName);
      this.channelMapping.delete(channelId);
      return savedName;
    } catch (error) {
      console.error(`Failed to archive channel ${channelId}:`, error);
      return null;
    }
  }

  /**
   * Send an AskUserQuestion as an embed with interactive buttons.
   * Returns the selected option label, or null on timeout.
   */
  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs: number = 300000
  ): Promise<string | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    const textChannel = channel as TextChannel;

    const q = questions[0];
    if (!q) return null;

    const embed = new EmbedBuilder()
      .setTitle(`❓ ${q.header || 'Question'}`)
      .setDescription(q.question)
      .setColor(0x5865f2);

    if (q.options.some((o) => o.description)) {
      embed.addFields(
        q.options.map((opt) => ({
          name: opt.label,
          value: opt.description || '\u200b',
          inline: true,
        }))
      );
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let row = new ActionRowBuilder<ButtonBuilder>();

    for (let i = 0; i < q.options.length; i++) {
      if (i > 0 && i % 5 === 0) {
        rows.push(row);
        row = new ActionRowBuilder<ButtonBuilder>();
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`opt_${i}`)
          .setLabel(q.options[i].label.slice(0, 80))
          .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      );
    }
    rows.push(row);

    const message = await textChannel.send({
      embeds: [embed],
      components: rows,
    });

    try {
      const interaction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => !i.user.bot,
        time: timeoutMs,
      });

      const optIndex = parseInt(interaction.customId.split('_')[1]);
      const selected = q.options[optIndex]?.label || '';

      await interaction.update({
        embeds: [embed.setColor(0x57f287).setFooter({ text: `✅ ${selected}` })],
        components: [],
      });

      return selected;
    } catch {
      await message
        .edit({
          embeds: [embed.setColor(0x95a5a6).setFooter({ text: '⏰ Timed out' })],
          components: [],
        })
        .catch(() => {});
      return null;
    }
  }

  private buildLongOutputPreview(content: string, maxLength: number = 180): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength - 1)}…`;
  }

  private resolveBooleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (!raw) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
  }

  private shouldScanExistingChannels(): boolean {
    // Disabled by default so only explicit state bindings are routed.
    // Set AGENT_DISCORD_SCAN_EXISTING_CHANNELS=true to opt in to legacy name-based discovery.
    return this.resolveBooleanEnv('AGENT_DISCORD_SCAN_EXISTING_CHANNELS', false);
  }

  private shouldSuppressNotifications(): boolean {
    return this.resolveBooleanEnv('AGENT_DISCORD_SUPPRESS_NOTIFICATIONS', true);
  }

  private resolveSendMaxRetries(): number {
    const rawValue = process.env.AGENT_DISCORD_SEND_MAX_RETRIES;
    if (!rawValue || rawValue.trim().length === 0) {
      return DEFAULT_DISCORD_SEND_MAX_RETRIES;
    }
    const raw = Number(rawValue);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 10) {
      return Math.trunc(raw);
    }
    return DEFAULT_DISCORD_SEND_MAX_RETRIES;
  }

  private buildBaseSendOptions(): {
    allowedMentions: { parse: []; repliedUser: boolean };
    flags?: number;
  } {
    const payload: {
      allowedMentions: { parse: []; repliedUser: boolean };
      flags?: number;
    } = {
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    };
    if (this.shouldSuppressNotifications()) {
      payload.flags = SUPPRESS_NOTIFICATIONS_FLAG;
    }
    return payload;
  }

  private buildTextSendPayload(content: string): {
    content: string;
    allowedMentions: { parse: []; repliedUser: boolean };
    flags?: number;
  } {
    return {
      content,
      ...this.buildBaseSendOptions(),
    };
  }

  private buildFileSendPayload(
    content: string | undefined,
    files: AttachmentBuilder[],
  ): {
    content?: string;
    files: AttachmentBuilder[];
    allowedMentions: { parse: []; repliedUser: boolean };
    flags?: number;
  } {
    return {
      content,
      files,
      ...this.buildBaseSendOptions(),
    };
  }

  private extractRetryAfterMs(error: unknown): number | null {
    const payload = error as {
      retryAfter?: unknown;
      retry_after?: unknown;
      data?: { retry_after?: unknown };
      rawError?: { retry_after?: unknown };
    };
    const fromCamel = Number(payload.retryAfter);
    if (Number.isFinite(fromCamel) && fromCamel > 0) {
      // discord.js retryAfter is already in milliseconds.
      return Math.round(fromCamel);
    }

    // Discord API retry_after is provided in seconds.
    const fromSnake = Number(payload.retry_after ?? payload.data?.retry_after ?? payload.rawError?.retry_after);
    if (!Number.isFinite(fromSnake) || fromSnake <= 0) return null;
    return Math.round(fromSnake * 1000);
  }

  private isRetriableSendError(error: unknown): boolean {
    const payload = error as { status?: unknown; code?: unknown; rawError?: { status?: unknown }; message?: unknown };
    const status = Number(payload.status ?? payload.code ?? payload.rawError?.status);
    if ([429, 500, 502, 503, 504].includes(status)) return true;

    const message = typeof payload.message === 'string' ? payload.message : '';
    return /rate limit|timed out|timeout|econnreset|socket hang up|eai_again|service unavailable/i.test(message);
  }

  private computeRetryDelayMs(attempt: number, error: unknown): number {
    const retryAfter = this.extractRetryAfterMs(error);
    if (retryAfter !== null) {
      return Math.max(50, Math.min(retryAfter, DISCORD_SEND_MAX_BACKOFF_MS));
    }
    const base = DISCORD_SEND_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * 120);
    return Math.min(base + jitter, DISCORD_SEND_MAX_BACKOFF_MS);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendWithRetry<T>(context: string, operation: () => Promise<T>): Promise<T> {
    const maxRetries = this.resolveSendMaxRetries();
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxRetries || !this.isRetriableSendError(error)) {
          throw error;
        }
        const delay = this.computeRetryDelayMs(attempt + 1, error);
        console.warn(`Discord send retry ${attempt + 1}/${maxRetries} (${context}) in ${delay}ms`);
        await this.sleep(delay);
      }
    }
  }

  private async enqueueSend(queueKey: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sendQueues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.sendQueues.set(queueKey, next);
    try {
      await next;
    } finally {
      if (this.sendQueues.get(queueKey) === next) {
        this.sendQueues.delete(queueKey);
      }
    }
  }

  private splitForSend(content: string): string[] {
    if (content.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      return [content];
    }
    return splitForDiscord(content);
  }

  private annotatePagedChunks(chunks: string[], label: string): string[] {
    if (chunks.length <= 1) return chunks;
    return chunks.map((chunk, index) => `**${label} ${index + 1}/${chunks.length}**\n${chunk}`);
  }

  private async sendSplitText(
    queueKey: string,
    target: { send: (payload: unknown) => Promise<unknown> },
    content: string,
    label: 'Part' | 'Page',
  ): Promise<void> {
    const chunks = this.splitForSend(content).map((chunk) => chunk.trimEnd()).filter((chunk) => chunk.trim().length > 0);
    if (chunks.length === 0) return;
    const decorated = this.annotatePagedChunks(chunks, label);
    await this.enqueueSend(queueKey, async () => {
      for (const chunk of decorated) {
        await this.sendWithRetry(`text:${queueKey}`, async () => {
          await target.send(this.buildTextSendPayload(chunk));
        });
      }
    });
  }

  async sendLongOutput(channelId: string, content: string): Promise<void> {
    const full = content.trim();
    if (full.length === 0) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        return;
      }

      const textChannel = channel as TextChannel;
      const preview = this.buildLongOutputPreview(full);
      let anchor: unknown;
      await this.enqueueSend(channelId, async () => {
        anchor = await this.sendWithRetry(`long-output-anchor:${channelId}`, async () =>
          textChannel.send(
            this.buildTextSendPayload(
              `🧾 **Long response received**\n` +
              `Full output was posted in a thread.\n` +
              `Preview: ${preview}`,
            ),
          ),
        );
      });

      try {
        const threadName = `output-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
        const thread = await (anchor as any)?.startThread({
          name: threadName,
          autoArchiveDuration: 60,
          reason: 'mudcode long response overflow',
        });
        const threadId = typeof thread?.id === 'string' && thread.id.length > 0 ? thread.id : `${channelId}:long-output-thread`;
        await this.sendSplitText(threadId, thread as { send: (payload: unknown) => Promise<unknown> }, full, 'Page');
      } catch (threadError) {
        console.warn(`Failed to create thread for long output on ${channelId}:`, threadError);
        await this.sendSplitText(channelId, textChannel as { send: (payload: unknown) => Promise<unknown> }, full, 'Part');
      }
    } catch (error) {
      console.error(`Failed to send long output to channel ${channelId}:`, error);
    }
  }

  /**
   * Send a message to a specific channel by ID
   */
  async sendToChannel(channelId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        console.warn(`Channel ${channelId} is not a text channel`);
        return;
      }
      await this.sendSplitText(channelId, channel as { send: (payload: unknown) => Promise<unknown> }, content, 'Part');
    } catch (error) {
      console.error(`Failed to send message to channel ${channelId}:`, error);
    }
  }

  /**
   * Send a message with file attachments to a specific channel.
   * If content is empty but files are present, sends files only.
   */
  async sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        console.warn(`Channel ${channelId} is not a text channel`);
        return;
      }
      const files = filePaths.map((fp) => new AttachmentBuilder(fp));
      await this.enqueueSend(channelId, async () => {
        await this.sendWithRetry(`files:${channelId}`, async () =>
          (channel as TextChannel).send(this.buildFileSendPayload(content || undefined, files)),
        );
      });
    } catch (error) {
      console.error(`Failed to send message with files to channel ${channelId}:`, error);
    }
  }

  async addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(emoji);
    } catch (error) {
      console.warn(`Failed to add reaction ${emoji} on ${channelId}/${messageId}:`, error);
    }
  }

  async replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);

      const fromReaction = message.reactions.cache.find((reaction) => reaction.emoji.name === fromEmoji);
      const botUserId = this.client.user?.id;
      if (fromReaction && botUserId) {
        await fromReaction.users.remove(botUserId).catch(() => undefined);
      }

      await message.react(toEmoji);
    } catch (error) {
      console.warn(`Failed to replace reaction on ${channelId}/${messageId}:`, error);
    }
  }

  async startTypingIndicator(channelId: string): Promise<() => void> {
    const existing = this.typingIndicators.get(channelId);
    if (existing) {
      existing.refs += 1;
      return () => this.stopTypingIndicator(channelId);
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('sendTyping' in channel)) {
      return () => {};
    }

    const textChannel = channel as TextChannel;
    await textChannel.sendTyping().catch(() => undefined);

    const timer = setInterval(() => {
      void textChannel.sendTyping().catch(() => undefined);
    }, 8000);

    this.typingIndicators.set(channelId, { timer, refs: 1 });
    return () => this.stopTypingIndicator(channelId);
  }

  private stopTypingIndicator(channelId: string): void {
    const state = this.typingIndicators.get(channelId);
    if (!state) return;

    state.refs -= 1;
    if (state.refs <= 0) {
      clearInterval(state.timer);
      this.typingIndicators.delete(channelId);
    }
  }
}
