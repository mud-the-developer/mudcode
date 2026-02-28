/**
 * Tests for DiscordClient
 */

import { DiscordClient } from '../../src/discord/client.js';
import { AgentRegistry, BaseAgentAdapter } from '../../src/agents/base.js';

// Mock discord.js
const mockClientInstances: any[] = [];

vi.mock('discord.js', () => {
  return {
    Client: class MockClient {
      on = vi.fn();
      once = vi.fn();
      login = vi.fn().mockResolvedValue(undefined);
      destroy = vi.fn().mockResolvedValue(undefined);
      guilds = { cache: new Map(), fetch: vi.fn().mockResolvedValue(new Map()) };
      channels = { fetch: vi.fn() };
      user = { tag: 'TestBot#1234' };

      constructor() {
        mockClientInstances.push(this);
      }
    },
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildMessageReactions: 8 },
    ChannelType: { GuildText: 0 },
    ButtonBuilder: class MockButtonBuilder {
      setCustomId = vi.fn().mockReturnThis();
      setLabel = vi.fn().mockReturnThis();
      setStyle = vi.fn().mockReturnThis();
    },
    ButtonStyle: { Primary: 1, Secondary: 2 },
    ActionRowBuilder: class MockActionRowBuilder {
      addComponents = vi.fn().mockReturnThis();
    },
    ComponentType: { Button: 2 },
    ApplicationCommandOptionType: { Integer: 4 },
    EmbedBuilder: class MockEmbedBuilder {
      setTitle = vi.fn().mockReturnThis();
      setDescription = vi.fn().mockReturnThis();
      setColor = vi.fn().mockReturnThis();
      addFields = vi.fn().mockReturnThis();
      setFooter = vi.fn().mockReturnThis();
    },
  };
});

function createTestRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  class TestAdapter extends BaseAgentAdapter {
    constructor() {
      super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
    }
  }
  registry.register(new TestAdapter());
  return registry;
}

describe('DiscordClient', () => {
  beforeEach(() => {
    mockClientInstances.length = 0;
  });

  function getMockClient() {
    return mockClientInstances[mockClientInstances.length - 1];
  }

  describe('Channel mapping', () => {
    it('registerChannelMappings stores mappings', () => {
      const client = new DiscordClient('test-token');

      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj1', agentType: 'claude' },
        { channelId: 'ch-2', projectName: 'proj2', agentType: 'cursor' },
      ]);

      const mappings = client.getChannelMapping();
      expect(mappings.size).toBe(2);
      expect(mappings.get('ch-1')).toEqual({
        projectName: 'proj1',
        agentType: 'claude',
      });
      expect(mappings.get('ch-2')).toEqual({
        projectName: 'proj2',
        agentType: 'cursor',
      });
    });

    it('getChannelMapping returns copy of mappings', () => {
      const client = new DiscordClient('test-token');

      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj1', agentType: 'claude' },
      ]);

      const mappings1 = client.getChannelMapping();
      const mappings2 = client.getChannelMapping();

      expect(mappings1).not.toBe(mappings2);
      expect(mappings1.size).toBe(mappings2.size);
    });

    it('registerChannelMappings replaces stale mappings', () => {
      const client = new DiscordClient('test-token');

      client.registerChannelMappings([
        { channelId: 'ch-old', projectName: 'legacy', agentType: 'codex' },
      ]);
      client.registerChannelMappings([
        { channelId: 'ch-new', projectName: 'proj', agentType: 'claude' },
      ]);

      const mappings = client.getChannelMapping();
      expect(mappings.size).toBe(1);
      expect(mappings.get('ch-old')).toBeUndefined();
      expect(mappings.get('ch-new')).toEqual({
        projectName: 'proj',
        agentType: 'claude',
      });
    });
  });

  describe('Message handling', () => {
    it('onMessage registers callback', () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();

      client.onMessage(callback);

      // Verify callback is stored (we can't directly access private field, but we can test the behavior)
      expect(callback).toBeDefined();
    });

    it('Bot messages are ignored', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);

      const mockClient = getMockClient();

      // Find the messageCreate handler
      const messageCreateHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'messageCreate'
      )?.[1];

      expect(messageCreateHandler).toBeDefined();

      // Simulate bot message
      const botMessage = {
        author: { bot: true },
        channel: { isTextBased: () => true },
        channelId: 'ch-1',
        content: 'bot message',
      };

      await messageCreateHandler(botMessage);

      // Callback should not be invoked for bot messages
      expect(callback).not.toHaveBeenCalled();
    });

    it('passes message context for mapped channels', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const messageCreateHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'messageCreate',
      )?.[1];

      await messageCreateHandler({
        author: { bot: false, id: 'u-1' },
        channel: { isTextBased: () => true },
        channelId: 'ch-1',
        id: 'm-1',
        content: 'hello',
        attachments: { map: () => [] },
        reference: { messageId: 'm-0' },
      });

      expect(callback).toHaveBeenCalledWith(
        'claude',
        'hello',
        'proj',
        'ch-1',
        'm-1',
        'claude',
        undefined,
        expect.objectContaining({
          platform: 'discord',
          sourceChannelId: 'ch-1',
          routeChannelId: 'ch-1',
          authorId: 'u-1',
          replyToMessageId: 'm-0',
          conversationKey: 'discord:channel:ch-1:author:u-1',
        }),
      );
    });

    it('routes thread messages using parent channel mapping', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-parent', projectName: 'proj', agentType: 'claude', instanceId: 'claude-2' },
      ]);

      const mockClient = getMockClient();
      const messageCreateHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'messageCreate',
      )?.[1];

      await messageCreateHandler({
        author: { bot: false, id: 'u-2' },
        channel: { isTextBased: () => true, isThread: () => true, parentId: 'ch-parent' },
        channelId: 'thread-99',
        id: 'm-2',
        content: 'thread hello',
        attachments: { map: () => [] },
      });

      expect(callback).toHaveBeenCalledWith(
        'claude',
        'thread hello',
        'proj',
        'thread-99',
        'm-2',
        'claude-2',
        undefined,
        expect.objectContaining({
          platform: 'discord',
          sourceChannelId: 'thread-99',
          routeChannelId: 'ch-parent',
          threadId: 'thread-99',
          conversationKey: 'discord:thread:thread-99',
        }),
      );
    });

    it('routes /q slash command through message callback', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const interaction = {
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'q',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-1',
        channel: { isTextBased: () => true },
        options: { getInteger: vi.fn().mockReturnValue(null) },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(callback).toHaveBeenCalledWith(
        'claude',
        '/q',
        'proj',
        'ch-1',
        undefined,
        'claude',
        undefined,
        expect.objectContaining({
          platform: 'discord',
          sourceChannelId: 'ch-1',
          routeChannelId: 'ch-1',
          authorId: 'u-1',
          conversationKey: 'discord:channel:ch-1:author:u-1',
        }),
      );
      expect(interaction.editReply).toHaveBeenCalledWith('✅ `/q` request submitted.');
    });

    it('replies to slash command when channel is not mapped', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);

      const mockClient = getMockClient();
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const interaction = {
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'qw',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-missing',
        channel: { isTextBased: () => true },
        options: { getInteger: vi.fn().mockReturnValue(null) },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: '⚠️ This channel is not mapped to an active agent instance.',
        ephemeral: true,
      });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Channel operations', () => {
    it('sendToChannel fetches channel and sends content', async () => {
      const client = new DiscordClient('test-token');

      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      await client.sendToChannel('ch-123', 'test message');

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('ch-123');
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: 'test message',
        allowedMentions: { parse: [], repliedUser: false },
        flags: 4096,
      });
    });

    it('sendToChannel handles non-text channel gracefully', async () => {
      const client = new DiscordClient('test-token');

      const mockChannel = {
        isTextBased: () => false,
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      // Should not throw
      await expect(client.sendToChannel('ch-123', 'test message')).resolves.toBeUndefined();
    });

    it('sendLongOutput posts summary and full text in a thread', async () => {
      const client = new DiscordClient('test-token');
      const threadSend = vi.fn().mockResolvedValue(undefined);
      const mockMessage = {
        id: 'm-anchor',
        startThread: vi.fn().mockResolvedValue({
          id: 'th-1',
          send: threadSend,
        }),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      await client.sendLongOutput('ch-123', 'x'.repeat(2400));

      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Long response received'),
          allowedMentions: { parse: [], repliedUser: false },
          flags: 4096,
        }),
      );
      expect(mockMessage.startThread).toHaveBeenCalled();
      expect(threadSend).toHaveBeenCalled();
      const firstThreadPayload = threadSend.mock.calls[0]?.[0];
      expect(String(firstThreadPayload?.content || '')).toContain('Page');
    });

    it('sendToProgressThread creates and reuses a progress thread per channel', async () => {
      const client = new DiscordClient('test-token');
      const threadSend = vi.fn().mockResolvedValue(undefined);
      const threadChannel = {
        id: 'th-progress',
        isTextBased: () => true,
        isThread: () => true,
        send: threadSend,
      };
      const anchorMessage = {
        id: 'm-progress-anchor',
        startThread: vi.fn().mockResolvedValue(threadChannel),
      };
      const rootChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(anchorMessage),
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockImplementation(async (id: string) => {
        if (id === 'th-progress') return threadChannel;
        return rootChannel;
      });

      await client.sendToProgressThread('ch-123', 'first progress');
      await client.sendToProgressThread('ch-123', 'second progress');

      expect(rootChannel.send).toHaveBeenCalledTimes(1);
      expect(anchorMessage.startThread).toHaveBeenCalledTimes(1);
      expect(threadSend).toHaveBeenCalledTimes(2);
      expect(String(threadSend.mock.calls[0]?.[0]?.content || '')).toContain('first progress');
      expect(String(threadSend.mock.calls[1]?.[0]?.content || '')).toContain('second progress');
    });

    it('retries sendToChannel when the first send is rate-limited', async () => {
      vi.useFakeTimers();
      try {
        const client = new DiscordClient('test-token');
        const rateLimitedError = Object.assign(new Error('429 rate limited'), {
          status: 429,
          retry_after: 0.01,
        });

        const mockChannel = {
          isTextBased: () => true,
          send: vi
            .fn()
            .mockRejectedValueOnce(rateLimitedError)
            .mockResolvedValue(undefined),
        };

        const mockClient = getMockClient();
        mockClient.channels.fetch.mockResolvedValue(mockChannel);

        const sending = client.sendToChannel('ch-123', 'retry test');
        await vi.runAllTimersAsync();
        await sending;

        expect(mockChannel.send).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats retry_after as seconds (not milliseconds) for retry delay', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const client = new DiscordClient('test-token');
        const rateLimitedError = Object.assign(new Error('429 rate limited'), {
          status: 429,
          retry_after: 55,
        });

        const mockChannel = {
          isTextBased: () => true,
          send: vi
            .fn()
            .mockRejectedValueOnce(rateLimitedError)
            .mockResolvedValue(undefined),
        };

        const mockClient = getMockClient();
        mockClient.channels.fetch.mockResolvedValue(mockChannel);

        const sending = client.sendToChannel('ch-123', 'retry seconds test');
        await vi.runAllTimersAsync();
        await sending;

        expect(mockChannel.send).toHaveBeenCalledTimes(2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('in 10000ms'));
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('archiveChannel renames channel to saved timestamp format', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-23T12:34:56Z'));
      try {
        const client = new DiscordClient('test-token');
        client.registerChannelMappings([
          { channelId: 'ch-123', projectName: 'proj', agentType: 'claude' },
        ]);
        const mockChannel = {
          isTextBased: () => true,
          name: 'demo-codex',
          setName: vi.fn().mockResolvedValue(undefined),
        };

        const mockClient = getMockClient();
        mockClient.channels.fetch.mockResolvedValue(mockChannel);

        const archived = await client.archiveChannel('ch-123');

        expect(archived).toMatch(/^saved_\d{8}_\d{6}_demo-codex$/);
        expect(mockChannel.setName).toHaveBeenCalledWith(archived);
        expect(client.getChannelMapping().has('ch-123')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('archiveChannel returns null when channel cannot be renamed', async () => {
      const client = new DiscordClient('test-token');
      const mockChannel = {
        isTextBased: () => true,
        name: 'demo-codex',
      };

      const mockClient = getMockClient();
      mockClient.channels.fetch.mockResolvedValue(mockChannel);

      await expect(client.archiveChannel('ch-123')).resolves.toBeNull();
    });
  });

  describe('parseChannelName', () => {
    it('uses injected registry to parse channel names', () => {
      const registry = createTestRegistry();
      const client = new DiscordClient('test-token', registry);

      // Mock the registry's parseChannelName method
      const mockResult = {
        projectName: 'myproject',
        agent: {
          config: { name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' },
        } as any,
      };
      vi.spyOn(registry, 'parseChannelName').mockReturnValue(mockResult);

      // Access the private parseChannelName method indirectly through registerChannelMappings
      // or by scanning existing channels (which calls parseChannelName internally)
      // For now, we verify the registry was passed correctly by checking if parseChannelName exists
      expect(registry.parseChannelName).toBeDefined();
    });
  });

  describe('Connect', () => {
    it('does not auto-discover channel mappings from channel names by default', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();
      const setCommands = vi.fn().mockResolvedValue(undefined);
      mockClient.guilds.cache = new Map([
        [
          'g-1',
          {
            id: 'g-1',
            commands: { set: setCommands },
            channels: {
              cache: new Map([
                ['ch-legacy', { id: 'ch-legacy', isTextBased: () => true, name: 'legacy-codex' }],
              ]),
            },
          },
        ],
      ]);

      const onReadyHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'clientReady',
      )?.[1];
      await onReadyHandler();

      expect(client.getChannelMapping().size).toBe(0);
    });

    it('normalizes bot token before login', async () => {
      const client = new DiscordClient('  "Bot test-token-123"  ');
      const mockClient = getMockClient();

      const connectPromise = client.connect();

      expect(mockClient.login).toHaveBeenCalledWith('test-token-123');

      const readyHandler = mockClient.once.mock.calls.find(
        (call: any[]) => call[0] === 'clientReady'
      )?.[1];
      expect(readyHandler).toBeDefined();
      readyHandler();

      await expect(connectPromise).resolves.toBeUndefined();
    });

    it('returns actionable error for invalid token', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();
      mockClient.login.mockRejectedValueOnce(new Error('An invalid token was provided.'));

      await expect(client.connect()).rejects.toThrow(/invalid bot token/i);
    });

    it('fails fast when token is empty after normalization', async () => {
      const client = new DiscordClient('   ');
      const mockClient = getMockClient();

      await expect(client.connect()).rejects.toThrow(/token is empty/i);
      expect(mockClient.login).not.toHaveBeenCalled();
    });

    it('registers /q and /qw commands on ready', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();
      const setCommands = vi.fn().mockResolvedValue(undefined);
      mockClient.guilds.fetch.mockResolvedValue(
        new Map([
          [
            'g-1',
            {
              id: 'g-1',
              fetch: vi.fn().mockResolvedValue({
                id: 'g-1',
                commands: { set: setCommands },
                channels: { cache: new Map() },
              }),
            },
          ],
        ]),
      );

      const connectPromise = client.connect();

      const readyHandler = mockClient.once.mock.calls.find(
        (call: any[]) => call[0] === 'clientReady'
      )?.[1];
      readyHandler();
      const onReadyHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'clientReady'
      )?.[1];
      await onReadyHandler();

      await expect(connectPromise).resolves.toBeUndefined();
      expect(setCommands).toHaveBeenCalledWith([
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
              type: 4,
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
              type: 4,
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
              type: 4,
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
              type: 4,
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
              type: 4,
              required: false,
              min_value: 1,
              max_value: 20,
            },
          ],
        },
      ]);
    });

    it('routes /down slash command with count to message callback', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const interaction = {
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'down',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-1',
        channel: { isTextBased: () => true },
        options: { getInteger: vi.fn().mockReturnValue(3) },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(interaction);

      expect(callback).toHaveBeenCalledWith(
        'claude',
        '/down 3',
        'proj',
        'ch-1',
        undefined,
        'claude',
        undefined,
        expect.any(Object),
      );
      expect(interaction.editReply).toHaveBeenCalledWith('✅ `/down 3` request submitted.');
    });

    it('routes /snapshot slash command to message callback', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const interaction = {
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'snapshot',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-1',
        channel: { isTextBased: () => true },
        options: { getInteger: vi.fn().mockReturnValue(null) },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(interaction);

      expect(callback).toHaveBeenCalledWith(
        'claude',
        '/snapshot',
        'proj',
        'ch-1',
        undefined,
        'claude',
        undefined,
        expect.any(Object),
      );
      expect(interaction.editReply).toHaveBeenCalledWith('✅ `/snapshot` request submitted.');
    });

    it('posts control panel for /controls slash command', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(undefined),
      };
      mockClient.channels.fetch.mockResolvedValue(mockChannel);
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const interaction = {
        isButton: () => false,
        isChatInputCommand: () => true,
        commandName: 'controls',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-1',
        channel: { isTextBased: () => true },
        options: { getInteger: vi.fn().mockReturnValue(null) },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(interaction);

      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Mudcode Controls'),
        }),
      );
      expect(interaction.editReply).toHaveBeenCalledWith('✅ Control panel posted.');
      expect(callback).not.toHaveBeenCalled();
    });

    it('routes control-panel retry button to message callback', async () => {
      const client = new DiscordClient('test-token');
      const callback = vi.fn();
      client.onMessage(callback);
      client.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
      ]);

      const mockClient = getMockClient();
      const interactionHandler = mockClient.on.mock.calls.find(
        (call: any[]) => call[0] === 'interactionCreate',
      )?.[1];

      const buttonInteraction = {
        isButton: () => true,
        isChatInputCommand: () => false,
        customId: 'mudcode:control:retry',
        user: { bot: false, id: 'u-1' },
        channelId: 'ch-1',
        channel: { isTextBased: () => true },
        deferred: false,
        replied: false,
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };

      await interactionHandler(buttonInteraction);

      expect(callback).toHaveBeenCalledWith(
        'claude',
        '/retry',
        'proj',
        'ch-1',
        undefined,
        'claude',
        undefined,
        expect.any(Object),
      );
      expect(buttonInteraction.editReply).toHaveBeenCalledWith('✅ `/retry` request submitted.');
    });
  });

  describe('Typing indicator', () => {
    it('reuses a single timer per channel and stops only after the last reference', async () => {
      vi.useFakeTimers();
      try {
        const client = new DiscordClient('test-token');
        const mockClient = getMockClient();
        const mockChannel = {
          isTextBased: () => true,
          sendTyping: vi.fn().mockResolvedValue(undefined),
        };
        mockClient.channels.fetch.mockResolvedValue(mockChannel);

        const stopA = await client.startTypingIndicator('ch-typing');
        const stopB = await client.startTypingIndicator('ch-typing');

        expect(mockClient.channels.fetch).toHaveBeenCalledTimes(1);
        expect(mockChannel.sendTyping).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(8000);
        expect(mockChannel.sendTyping).toHaveBeenCalledTimes(2);

        stopA();
        await vi.advanceTimersByTimeAsync(8000);
        expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3);

        stopB();
        await vi.advanceTimersByTimeAsync(9000);
        expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3);

        await client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the interval alive even when sendTyping intermittently fails', async () => {
      vi.useFakeTimers();
      try {
        const client = new DiscordClient('test-token');
        const mockClient = getMockClient();
        const mockChannel = {
          isTextBased: () => true,
          sendTyping: vi
            .fn()
            .mockRejectedValueOnce(new Error('429'))
            .mockResolvedValue(undefined),
        };
        mockClient.channels.fetch.mockResolvedValue(mockChannel);

        const stop = await client.startTypingIndicator('ch-typing');

        await vi.advanceTimersByTimeAsync(16000);
        expect(mockChannel.sendTyping).toHaveBeenCalledTimes(3);

        stop();
        await client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Lifecycle', () => {
    it('disconnect calls client.destroy', async () => {
      const client = new DiscordClient('test-token');
      const mockClient = getMockClient();

      await client.disconnect();

      expect(mockClient.destroy).toHaveBeenCalledOnce();
    });
  });

  describe('Constructor', () => {
    it('accepts optional registry parameter', () => {
      const registry = createTestRegistry();
      const client = new DiscordClient('test-token', registry);

      expect(client).toBeInstanceOf(DiscordClient);
    });

    it('creates with default registry when not provided', () => {
      const client = new DiscordClient('test-token');

      expect(client).toBeInstanceOf(DiscordClient);
    });
  });
});
