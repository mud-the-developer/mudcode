import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { SkillAutoLinker } from '../../src/bridge/skill-autolinker.js';

function createProjectState() {
  const now = new Date();
  return {
    projectName: 'demo',
    projectPath: '/tmp/demo',
    tmuxSession: 'agent-demo',
    agents: { codex: true },
    discordChannels: { codex: 'ch-1' },
    createdAt: now,
    lastActive: now,
    instances: {
      codex: {
        instanceId: 'codex',
        agentType: 'codex',
        tmuxWindow: 'demo-codex',
        channelId: 'ch-1',
        eventHook: false,
      },
    },
  };
}

function createMultiInstanceProjectState() {
  const now = new Date();
  return {
    projectName: 'demo',
    projectPath: '/tmp/demo',
    tmuxSession: 'agent-demo',
    agents: { codex: true },
    discordChannels: { codex: 'ch-1' },
    createdAt: now,
    lastActive: now,
    instances: {
      codex: {
        instanceId: 'codex',
        agentType: 'codex',
        tmuxWindow: 'demo-codex',
        channelId: 'ch-1',
        eventHook: false,
      },
      'codex-2': {
        instanceId: 'codex-2',
        agentType: 'codex',
        tmuxWindow: 'demo-codex-2',
        channelId: 'ch-2',
        eventHook: false,
      },
    },
  };
}

function createMessagingMock() {
  let callback: any;
  return {
    messaging: {
      platform: 'discord',
      onMessage: vi.fn((cb) => {
        callback = cb;
      }),
      sendToChannel: vi.fn().mockResolvedValue(undefined),
      deleteChannel: vi.fn().mockResolvedValue(true),
      archiveChannel: vi.fn().mockResolvedValue('saved_20260223_221500_demo-codex'),
    } as any,
    getCallback: () => callback,
  };
}

describe('BridgeMessageRouter (codex)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS;
    delete process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS;
    delete process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD;
    delete process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_REENTER_CHUNK_BOUNDARY;
    delete process.env.AGENT_DISCORD_TMUX_SEND_KEYS_CHUNK_SIZE;
    delete process.env.MUDCODE_CODEX_AUTO_SKILL_LINK;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relaunches codex instead of sending prompt when pane is at shell', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('zsh'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      skillAutoLinker: new SkillAutoLinker(),
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(tmux.sendKeysToWindow).not.toHaveBeenCalled();
    expect(pendingTracker.markRetry).toHaveBeenCalledWith('demo', 'codex', 'codex', 'tail');
    expect(pendingTracker.markError).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('relaunched `codex`'),
    );
  });

  it('submits prompt to codex pane when codex is active', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      skillAutoLinker: new SkillAutoLinker(),
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello codex', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'hello codex', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markError).not.toHaveBeenCalled();
    expect(pendingTracker.markRetry).not.toHaveBeenCalled();
  });

  it('auto-links AGENTS skill hint into codex prompt when applicable', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.MUDCODE_CODEX_AUTO_SKILL_LINK = '1';

    const projectPath = mkdtempSync(join(tmpdir(), 'mudcode-router-skill-'));
    tempDirs.push(projectPath);
    writeFileSync(
      join(projectPath, 'AGENTS.md'),
      [
        '# AGENTS',
        '### Available skills',
        '- rebuild-restart-daemon: Rebuild and restart the local daemon process. (file: /tmp/skill/restart/SKILL.md)',
      ].join('\n'),
      'utf-8',
    );

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createProjectState(),
        projectPath,
      }),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      skillAutoLinker: new SkillAutoLinker(),
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'Please rebuild and restart the daemon now.', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toContain('Please rebuild and restart the daemon now.');
    expect(sentPrompt).toContain('[mudcode auto-skill]');
    expect(sentPrompt).toContain('rebuild-restart-daemon');
  });

  it('re-sends Enter when codex submit verification still sees prompt tail', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD = '99999';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      capturePaneFromWindow: vi.fn().mockReturnValue('this is a prompt tail long enough for submit verification'),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'this is a prompt tail long enough for submit verification', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.sendEnterToWindow).toHaveBeenCalledTimes(2);
    expect(tmux.sendEnterToWindow).toHaveBeenNthCalledWith(1, 'agent-demo', 'demo-codex', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenNthCalledWith(2, 'agent-demo', 'demo-codex', 'codex');
  });

  it('does not re-send Enter when codex pane already shows working marker', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD = '99999';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello codex', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.sendEnterToWindow).toHaveBeenCalledTimes(1);
  });

  it('submits very long codex prompt via type+enter path without truncation', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    const longPrompt = `${'L'.repeat(9000)}\n\n`;
    await callback('codex', longPrompt, 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'L'.repeat(9000), 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledTimes(2);
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(pendingTracker.markError).not.toHaveBeenCalled();
  });

  it('auto-tunes Enter retry at 2000-char chunk boundary', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD = '99999';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_REENTER_CHUNK_BOUNDARY = 'true';
    process.env.AGENT_DISCORD_TMUX_SEND_KEYS_CHUNK_SIZE = '2000';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    const exactBoundaryPrompt = 'z'.repeat(2000);
    await callback('codex', exactBoundaryPrompt, 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', exactBoundaryPrompt, 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledTimes(2);
  });

  it('does not auto-retry just below boundary when verify does not indicate failure', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD = '99999';
    process.env.AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_REENTER_CHUNK_BOUNDARY = 'true';
    process.env.AGENT_DISCORD_TMUX_SEND_KEYS_CHUNK_SIZE = '2000';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      // Return a working marker so verify path does not request retry.
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'y'.repeat(1999), 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.sendEnterToWindow).toHaveBeenCalledTimes(1);
  });

  it('retries the last remembered prompt with /retry', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      sessionExistsFull: vi.fn().mockReturnValue(true),
      windowExists: vi.fn().mockReturnValue(true),
      capturePaneFromWindow: vi.fn().mockReturnValue(''),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'original prompt', 'demo', 'ch-1', 'msg-1', 'codex');
    await callback('codex', '/retry', 'demo', 'ch-1', 'msg-2', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenNthCalledWith(1, 'agent-demo', 'demo-codex', 'original prompt', 'codex');
    expect(tmux.typeKeysToWindow).toHaveBeenNthCalledWith(2, 'agent-demo', 'demo-codex', 'original prompt', 'codex');
    expect(messaging.sendToChannel).not.toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('No previous prompt found'),
    );
  });

  it('returns instance health summary for /health command', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      sessionExistsFull: vi.fn().mockReturnValue(true),
      windowExists: vi.fn().mockReturnValue(true),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getPendingDepth: vi.fn().mockReturnValue(0),
      getRuntimeSnapshot: vi.fn().mockReturnValue({
        pendingDepth: 1,
        oldestStage: 'processing',
        oldestAgeMs: 1200,
        latestStage: 'processing',
      }),
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/health', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Mudcode Health'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('input status: ✅ accepted'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('runtime status: 🟡 working'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('returns codex io tracker summary for /io command', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;
    const ioTracker = {
      buildStatus: vi.fn().mockReturnValue('🟢 i/o idle\nlatest transcript: `/tmp/demo.jsonl`'),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      ioTracker,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/io', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(ioTracker.buildStatus).toHaveBeenCalledWith('demo', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('i/o idle'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('returns current pane snapshot for /snapshot command', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      capturePaneFromWindow: vi.fn().mockReturnValue('line one\nline two'),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/snapshot', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.capturePaneFromWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('📸 Snapshot `demo/codex`'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('line one'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
    expect(tmux.sendEnterToWindow).not.toHaveBeenCalled();
    expect(tmux.sendRawKeyToWindow).not.toHaveBeenCalled();
  });

  it('returns only tail lines for /snapshot when pane is long', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const longSnapshot = Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`).join('\n');
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      capturePaneFromWindow: vi.fn().mockReturnValue(longSnapshot),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/snapshot', 'demo', 'ch-1', 'msg-1', 'codex');

    const sent = messaging.sendToChannel.mock.calls.map((call: any[]) => String(call[1] ?? '')).join('\n');
    expect(sent).toContain('last 30/40 lines');
    expect(sent).toContain('line-11');
    expect(sent).toContain('line-40');
    expect(sent).not.toContain('line-01');
  });

  it('treats codex as working when pane shows "Esc to interrupt" even if queue is empty', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      sessionExistsFull: vi.fn().mockReturnValue(true),
      windowExists: vi.fn().mockReturnValue(true),
      capturePaneFromWindow: vi.fn().mockReturnValue('? for shortcuts                                Esc to interrupt'),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getPendingDepth: vi.fn().mockReturnValue(0),
      getRuntimeSnapshot: vi.fn().mockReturnValue({
        pendingDepth: 0,
        lastTerminalStage: 'completed',
        lastTerminalAgeMs: 800,
      }),
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/health', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('runtime status: 🟡 working (pane shows `Esc to interrupt`)'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('tracker queue is empty, but pane still shows working'),
    );
  });

  it('continues tmux delivery even if pending reaction update fails', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockRejectedValue(new Error('reaction api failed')),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'deliver anyway', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'deliver anyway', 'codex');
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex');
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('prefers remembered conversation route over channel default', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createMultiInstanceProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback(
      'codex',
      'first',
      'demo',
      'ch-2',
      'msg-1',
      'codex-2',
      undefined,
      {
        platform: 'discord',
        sourceChannelId: 'ch-2',
        routeChannelId: 'ch-2',
        authorId: 'u-1',
        conversationKey: 'discord:channel:ch-1:author:u-1',
      },
    );
    await callback(
      'codex',
      'follow-up',
      'demo',
      'ch-1',
      'msg-2',
      undefined,
      undefined,
      {
        platform: 'discord',
        sourceChannelId: 'ch-1',
        routeChannelId: 'ch-1',
        authorId: 'u-1',
        conversationKey: 'discord:channel:ch-1:author:u-1',
      },
    );

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-2', 'follow-up', 'codex');
    expect(pendingTracker.markRouteResolved).toHaveBeenLastCalledWith('demo', 'codex', 'codex-2', 'memory');
  });

  it('sends /enter key command to tmux without submitting prompt', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/enter', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.sendRawKeyToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'Enter', 'codex');
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
    expect(tmux.sendEnterToWindow).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex', 'tail');
  });

  it('supports /down key command with repeat count', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/down 3', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.sendRawKeyToWindow).toHaveBeenCalledTimes(3);
    expect(tmux.sendRawKeyToWindow).toHaveBeenNthCalledWith(1, 'agent-demo', 'demo-codex', 'Down', 'codex');
  });

  it('rejects invalid slash key count with guidance', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/enter abc', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Count must be a number'),
    );
    expect(pendingTracker.markPending).not.toHaveBeenCalled();
    expect(tmux.sendRawKeyToWindow).not.toHaveBeenCalled();
  });

  it('guides legacy !key commands to slash commands', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '!enter', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('slash commands'),
    );
    expect(pendingTracker.markPending).not.toHaveBeenCalled();
    expect(tmux.sendRawKeyToWindow).not.toHaveBeenCalled();
  });

  it('/q closes tmux window, removes state, and deletes active channel', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      killWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      setProject: vi.fn(),
      removeProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/q', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.killWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex');
    expect(stateManager.removeProject).toHaveBeenCalledWith('demo');
    expect(messaging.deleteChannel).toHaveBeenCalledWith('ch-1');
    expect(messaging.archiveChannel).not.toHaveBeenCalled();
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex', 'tail');
    expect(pendingTracker.clearPendingForInstance).toHaveBeenCalledWith('demo', 'codex', 'codex');
  });

  it('/qw closes tmux window and renames channel to saved name', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
      killWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue(createProjectState()),
      setProject: vi.fn(),
      removeProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/qw', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.killWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex');
    expect(stateManager.removeProject).toHaveBeenCalledWith('demo');
    expect(messaging.archiveChannel).toHaveBeenCalledWith('ch-1');
    expect(messaging.deleteChannel).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Saved this channel as'),
    );
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('demo', 'codex', 'codex', 'tail');
    expect(pendingTracker.clearPendingForInstance).toHaveBeenCalledWith('demo', 'codex', 'codex');
  });
});
