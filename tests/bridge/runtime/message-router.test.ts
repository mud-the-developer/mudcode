import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeMessageRouter } from '../../../src/bridge/runtime/message-router.js';
import { SkillAutoLinker } from '../../../src/bridge/skills/skill-autolinker.js';

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
      sendLongOutput: vi.fn().mockResolvedValue(undefined),
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
    delete process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_CHARS;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_LINES;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_BULLETS;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE;
    delete process.env.AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE;
    delete process.env.MUDCODE_CODEX_AUTO_SKILL_LINK;
    delete process.env.AGENT_DISCORD_SNAPSHOT_LONG_OUTPUT_THREAD_THRESHOLD;
    delete process.env.AGENT_DISCORD_SNAPSHOT_CAPTURE_HISTORY_LINES;
    delete process.env.AGENT_DISCORD_SNAPSHOT_TAIL_LINES;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_WAIT_TIMEOUT_MS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_RETRIES;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_RETRY_BACKOFF_MS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_DEPTH;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER_PROMPT_MAX_CHARS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_ITEMS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_CHARS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_PACKET_ARTIFACT_ENABLED;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_DELEGATION_CONTRACT_MODE;
    delete process.env.AGENT_DISCORD_ORCHESTRATOR_SUPERVISOR_GUARD;
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

  it('emits codex session.start hook after successful codex submit', async () => {
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
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      eventHookClient,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello start hook', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(eventHookClient.emitCodexStart).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-1',
      channelId: 'ch-1',
    });
    expect(eventHookClient.emitCodexError).not.toHaveBeenCalled();
  });

  it('emits codex session.error hook when codex submit fails', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn().mockImplementation(() => {
        throw new Error('tmux write failed');
      }),
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
    const eventHookClient = {
      enabled: true,
      post: vi.fn().mockResolvedValue(true),
      emitCodexStart: vi.fn().mockResolvedValue(true),
      emitCodexProgress: vi.fn().mockResolvedValue(true),
      emitCodexFinal: vi.fn().mockResolvedValue(true),
      emitCodexError: vi.fn().mockResolvedValue(true),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      eventHookClient,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'hello error hook', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(eventHookClient.emitCodexError).toHaveBeenCalledWith({
      projectName: 'demo',
      instanceId: 'codex',
      turnId: 'msg-1',
      channelId: 'ch-1',
      text: 'tmux write failed',
    });
    expect(pendingTracker.markError).toHaveBeenCalledWith('demo', 'codex', 'codex', 'tail');
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

  it('auto-injects sub-agent hint for large codex prompts', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT = '1';
    process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_CHARS = '2400';

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
    const longPrompt = `Refactor this module:\n\n${'A'.repeat(2600)}`;
    await callback('codex', longPrompt, 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toContain('[mudcode auto-subagent]');
    expect(sentPrompt).toContain('sub-agent Codex workers');
  });

  it('does not inject sub-agent hint when prompt already requests sub-agent split', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT = '1';
    process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_CHARS = '1200';

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
    const alreadySplit = `Use sub-agent codex and split tasks by file ownership.\n\n${'B'.repeat(1400)}`;
    await callback('codex', alreadySplit, 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toContain('Use sub-agent codex');
    expect(sentPrompt).not.toContain('[mudcode auto-subagent]');
  });

  it('auto-injects long-task report hint for continuation prompts', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'continue';

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
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toContain('continue');
    expect(sentPrompt).toContain('[mudcode longtask-report]');
    expect(sentPrompt).toContain('Need your check');
    expect(sentPrompt).toContain('Changes');
    expect(sentPrompt).toContain('Verification');
  });

  it('does not inject long-task report hint when disabled', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

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
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toBe('continue');
    expect(sentPrompt).not.toContain('[mudcode longtask-report]');
  });

  it('injects supervisor orchestration guard for supervisor prompts when orchestrator is enabled', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';
    process.env.AGENT_DISCORD_ORCHESTRATOR_SUPERVISOR_GUARD = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(
      tmux.typeKeysToWindow.mock.calls.find((call: unknown[]) => call[1] === 'demo-codex')?.[2] ?? '',
    );
    expect(sentPrompt).toContain('continue');
    expect(sentPrompt).toContain('[mudcode supervisor-orchestrator-guard]');
    expect(sentPrompt).toContain('Do not directly implement code before delegating');
  });

  it('auto-injects language policy hint for korean codex prompts', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE = 'korean';

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
    await callback('codex', '이 코드 구조를 점검하고 개선해줘', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toContain('[mudcode language-policy]');
    expect(sentPrompt).toContain('Reason and plan internally in English');
    expect(sentPrompt).toContain('final user-facing response in the user\'s language');
  });

  it('does not inject language policy hint for english prompt in korean mode', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';
    process.env.AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE = 'korean';

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
    await callback('codex', 'refactor this module', 'demo', 'ch-1', 'msg-1', 'codex');

    const sentPrompt = String(tmux.typeKeysToWindow.mock.calls[0]?.[2] ?? '');
    expect(sentPrompt).toBe('refactor this module');
    expect(sentPrompt).not.toContain('[mudcode language-policy]');
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
    process.env.AGENT_DISCORD_CODEX_AUTO_SUBAGENT = '0';

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

  it('runs /doctor and sends summary to channel', async () => {
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
    const doctorRunner = vi.fn().mockResolvedValue({
      ok: true,
      fixed: false,
      issues: [
        {
          level: 'warn',
          code: 'event-contract-progress-channel',
          message: 'codex runtime progressMode=channel detected',
        },
      ],
      fixes: [],
      summary: {
        configPath: '/tmp/config.json',
        storedThreshold: 20000,
        envThresholdRaw: undefined,
        effectiveThreshold: 20000,
        runtimeProgressModeOff: 0,
        runtimeProgressModeThread: 1,
        runtimeProgressModeChannel: 1,
        runtimeProgressModeUnknown: 0,
        runtimeCodexProgressModeChannel: 1,
      },
    });

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      doctorRunner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/doctor', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(doctorRunner).toHaveBeenCalledWith({ fix: false });
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Mudcode Doctor'),
    );
    const sentSummary = String(messaging.sendToChannel.mock.calls[0]?.[1] || '');
    expect(sentSummary).toContain('progress modes: off=0, thread=1, channel=1, unknown=0');
    expect(sentSummary).toContain('contract highlights:');
    expect(sentSummary).toContain('event-contract-progress-channel');
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('runs /doctor fix with auto-fix enabled', async () => {
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
    const doctorRunner = vi.fn().mockResolvedValue({
      ok: true,
      fixed: true,
      issues: [{ level: 'warn', code: 'threshold-conflict', message: 'conflict resolved' }],
      fixes: [{ code: 'save-config-threshold', message: 'saved 20000' }],
      summary: {
        configPath: '/tmp/config.json',
        storedThreshold: 20000,
        envThresholdRaw: undefined,
        effectiveThreshold: 20000,
        runtimeProgressModeOff: 1,
        runtimeProgressModeThread: 0,
        runtimeProgressModeChannel: 0,
        runtimeProgressModeUnknown: 0,
        runtimeCodexProgressModeChannel: 0,
      },
    });

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      doctorRunner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/doctor fix', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(doctorRunner).toHaveBeenCalledWith({ fix: true });
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('auto-fixed'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('schedules /update command in background', async () => {
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
    const backgroundCliRunner = vi.fn();

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      backgroundCliRunner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/update', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(backgroundCliRunner).toHaveBeenCalledWith(['update'], 350);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Starting mudcode update'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('schedules /update --git command in background', async () => {
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
    const backgroundCliRunner = vi.fn();

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      backgroundCliRunner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/update --git', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(backgroundCliRunner).toHaveBeenCalledWith(['update', '--git'], 350);
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('schedules /daemon-restart in background', async () => {
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
    const backgroundCliRunner = vi.fn();

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      backgroundCliRunner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', '/daemon-restart', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(backgroundCliRunner).toHaveBeenCalledWith(['daemon', 'restart'], 350);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Scheduling daemon restart'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('blocks manual /orchestrator commands when manual mode is disabled', async () => {
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '0';

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
      setProject: vi.fn(),
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
    await callback('codex', '/orchestrator status', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Manual orchestrator commands are disabled'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
    expect(stateManager.setProject).not.toHaveBeenCalled();
  });

  it('enables orchestrator mode from runtime command and persists project state', async () => {
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = createMultiInstanceProjectState();
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
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
    });
    router.register();

    const callback = getCallback();
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator enable codex hidden', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(stateManager.setProject).toHaveBeenCalled();
    expect(projectState.orchestrator).toMatchObject({
      enabled: true,
      supervisorInstanceId: 'codex',
      workerFinalVisibility: 'hidden',
    });
    expect(projectState.orchestrator?.workerInstanceIds).toContain('codex-2');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Orchestrator enabled'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('spawns dynamic orchestrator workers from supervisor command', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = {
      ...createMultiInstanceProjectState(),
      orchestrator: {
        enabled: true,
        supervisorInstanceId: 'codex',
        workerInstanceIds: ['codex-2'],
        workerFinalVisibility: 'hidden',
      },
    };
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
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
    const orchestratorWorkerProvisioner = {
      spawnCodexWorkers: vi.fn().mockImplementation(async () => {
        const created = {
          instanceId: 'codex-3',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-3',
          eventHook: false,
        };
        projectState = {
          ...projectState,
          instances: {
            ...(projectState.instances || {}),
            'codex-3': created,
          },
        };
        return {
          created: [created],
        };
      }),
      teardownWorker: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      orchestratorWorkerProvisioner,
    });
    router.register();

    const callback = getCallback();
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator spawn 1', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(orchestratorWorkerProvisioner.spawnCodexWorkers).toHaveBeenCalledWith({
      projectName: 'demo',
      count: 1,
    });
    expect(projectState.instances?.['codex-3']).toBeTruthy();
    expect(projectState.orchestrator?.workerInstanceIds).toContain('codex-3');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Spawned worker instance(s): `codex-3`'),
    );
  });

  it('caps /orchestrator spawn count at 15', async () => {
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
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
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
    const orchestratorWorkerProvisioner = {
      spawnCodexWorkers: vi.fn().mockResolvedValue({
        created: [],
        warnings: ['no capacity'],
      }),
      teardownWorker: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      orchestratorWorkerProvisioner,
    });
    router.register();

    const callback = getCallback();
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator spawn 99', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(orchestratorWorkerProvisioner.spawnCodexWorkers).toHaveBeenCalledWith({
      projectName: 'demo',
      count: 15,
    });
  });

  it('removes dynamic orchestrator worker and updates orchestrator registry', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = {
      ...createMultiInstanceProjectState(),
      instances: {
        ...createMultiInstanceProjectState().instances,
        'codex-3': {
          instanceId: 'codex-3',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-3',
          channelId: 'ch-3',
          eventHook: false,
        },
      },
      orchestrator: {
        enabled: true,
        supervisorInstanceId: 'codex',
        workerInstanceIds: ['codex-2', 'codex-3'],
        workerFinalVisibility: 'hidden',
      },
    };
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
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
    const orchestratorWorkerProvisioner = {
      spawnCodexWorkers: vi.fn(),
      teardownWorker: vi.fn().mockImplementation(async () => {
        const removed = projectState.instances?.['codex-3'];
        const nextInstances = { ...(projectState.instances || {}) };
        delete nextInstances['codex-3'];
        projectState = {
          ...projectState,
          instances: nextInstances,
        };
        return {
          removed: true,
          removedInstance: removed,
        };
      }),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      orchestratorWorkerProvisioner,
    });
    router.register();

    const callback = getCallback();
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator remove codex-3', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(orchestratorWorkerProvisioner.teardownWorker).toHaveBeenCalledWith({
      projectName: 'demo',
      workerInstanceId: 'codex-3',
    });
    expect(pendingTracker.clearPendingForInstance).toHaveBeenCalledWith('demo', 'codex', 'codex-3');
    expect(projectState.instances?.['codex-3']).toBeUndefined();
    expect(projectState.orchestrator?.workerInstanceIds).not.toContain('codex-3');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Removed worker `codex-3`'),
    );
  });

  it('returns orchestrator status summary via runtime command', async () => {
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
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator status', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Orchestrator: enabled'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('workers(1): `codex-2`'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('worker index: #1->`codex-2`'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('worker runtime:'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
  });

  it('auto-enables orchestrator for multi-codex project on normal prompt', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = createMultiInstanceProjectState();
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
      }),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback('codex', 'implement queue worker', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(stateManager.setProject).toHaveBeenCalled();
    expect(projectState.orchestrator).toMatchObject({
      enabled: true,
      supervisorInstanceId: 'codex',
    });
    expect(projectState.orchestrator?.workerInstanceIds).toContain('codex-2');
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex',
      expect.stringContaining('implement queue worker'),
      'codex',
    );
  });

  it('auto-dispatches supporting worker task on continuation prompt', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = createMultiInstanceProjectState();
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
      }),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex',
      expect.stringContaining('continue'),
      'codex',
    );
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-2', 'continue', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Auto orchestration: dispatched supporting task to worker `codex-2`'),
    );
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-2',
      expect.stringMatching(/^orch-demo-codex-codex-2-/),
      'codex-2',
      'continue',
    );
  });

  it('auto-dispatches fanout worker tasks when max workers is configured', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '2';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '0';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = {
      ...createMultiInstanceProjectState(),
      instances: {
        ...createMultiInstanceProjectState().instances,
        'codex-3': {
          instanceId: 'codex-3',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-3',
          channelId: 'ch-3',
          eventHook: false,
        },
      },
    };
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
      }),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex',
      expect.stringContaining('continue'),
      'codex',
    );
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-2', 'continue', 'codex');
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-3', 'continue', 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Auto orchestration fanout'),
    );
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-2',
      expect.stringMatching(/^orch-demo-codex-codex-2-/),
      'codex-2',
      'continue',
    );
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-3',
      expect.stringMatching(/^orch-demo-codex-codex-3-/),
      'codex-3',
      'continue',
    );
  });

  it('auto-provisions codex workers when auto dispatch needs workers', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '2';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS = '2';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = createProjectState();
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
      }),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
      markPending: vi.fn().mockResolvedValue(undefined),
      markRouteResolved: vi.fn().mockResolvedValue(undefined),
      markHasAttachments: vi.fn().mockResolvedValue(undefined),
      markDispatching: vi.fn().mockResolvedValue(undefined),
      markRetry: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      clearPendingForInstance: vi.fn(),
    } as any;
    const orchestratorWorkerProvisioner = {
      spawnCodexWorkers: vi.fn().mockImplementation(async () => {
        const created = [
          {
            instanceId: 'codex-2',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-2',
            channelId: 'ch-2',
            eventHook: false,
          },
          {
            instanceId: 'codex-3',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-3',
            channelId: 'ch-3',
            eventHook: false,
          },
        ];
        projectState = {
          ...projectState,
          instances: {
            ...(projectState.instances || {}),
            'codex-2': created[0],
            'codex-3': created[1],
          },
        };
        return { created };
      }),
      teardownWorker: vi.fn(),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      orchestratorWorkerProvisioner,
    });
    router.register();

    const callback = getCallback();
    await callback('codex', 'continue', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(orchestratorWorkerProvisioner.spawnCodexWorkers).toHaveBeenCalledWith({
      projectName: 'demo',
      count: 2,
    });
    expect(projectState.orchestrator?.enabled).toBe(true);
    expect(projectState.orchestrator?.workerInstanceIds).toEqual(expect.arrayContaining(['codex-2', 'codex-3']));
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-2', expect.stringContaining('[mudcode orchestrator-plan]'), 'codex');
    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-3', expect.stringContaining('[mudcode orchestrator-plan]'), 'codex');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Auto worker provisioned'),
    );
  });

  it('uses planner assignments for auto fanout worker prompts', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '2';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '1';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        instances: {
          ...createMultiInstanceProjectState().instances,
          'codex-3': {
            instanceId: 'codex-3',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-3',
            channelId: 'ch-3',
            eventHook: false,
          },
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback(
      'codex',
      [
        'continue',
        '- inspect current event-contract regressions',
        '- implement router/runtime fixes',
        '- update tests and verify',
      ].join('\n'),
      'demo',
      'ch-1',
      'msg-1',
      'codex',
    );

    const workerCalls = tmux.typeKeysToWindow.mock.calls.filter((call: unknown[]) => (
      call[1] === 'demo-codex-2' || call[1] === 'demo-codex-3'
    ));
    expect(workerCalls.length).toBe(2);
    const workerPrompt1 = String(workerCalls[0]?.[2] || '');
    const workerPrompt2 = String(workerCalls[1]?.[2] || '');
    expect(workerPrompt1).toContain('[mudcode orchestrator-plan]');
    expect(workerPrompt2).toContain('[mudcode orchestrator-plan]');
    expect(workerPrompt1 + '\n' + workerPrompt2).toContain('Task packet: v1');
    expect(workerPrompt1 + '\n' + workerPrompt2).toContain('[rolling-summary]');
    expect(workerPrompt1 + '\n' + workerPrompt2).toContain('[context-hints]');
    expect(workerPrompt1 + '\n' + workerPrompt2).toContain('inspect current event-contract regressions');
    expect(workerPrompt1 + '\n' + workerPrompt2).toContain('implement router/runtime fixes');
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Auto orchestration fanout (planner)'),
    );
  });

  it('applies context budget gate for auto planner worker task packets', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS = '900';
    process.env.AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS = '450';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const tempProjectPath = mkdtempSync(join(tmpdir(), 'mudcode-orch-packet-'));
    tempDirs.push(tempProjectPath);
    const projectState = {
      ...createMultiInstanceProjectState(),
      projectPath: tempProjectPath,
    };
    const stateManager = {
      getProject: vi.fn().mockReturnValue(projectState),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    const longTailMarker = 'TAIL_MARKER_SHOULD_BE_TRUNCATED_ABCDE';
    const longPrompt = [
      'continue',
      '- implement event contract parity and planner packet migration',
      '- add tests for context budget gate',
      '- verify runtime doctor integration',
      'details:',
      'A'.repeat(1300),
      longTailMarker,
    ].join('\n');
    await callback('codex', longPrompt, 'demo', 'ch-1', 'msg-1', 'codex');

    const workerCalls = tmux.typeKeysToWindow.mock.calls.filter((call: unknown[]) => call[1] === 'demo-codex-2');
    expect(workerCalls.length).toBeGreaterThan(0);
    const workerPrompt = String(workerCalls[0]?.[2] || '');
    expect(workerPrompt).toContain('Task packet file:');
    expect(workerPrompt).toContain('packet_digest=');
    expect(workerPrompt).not.toContain(longTailMarker);
    const match = workerPrompt.match(/Task packet file:\s+([^\n]+)/);
    expect(match?.[1]).toBeTruthy();
    const packetRelativePath = String(match?.[1] || '').trim();
    const packetAbsolutePath = join(tempProjectPath, packetRelativePath);
    expect(existsSync(packetAbsolutePath)).toBe(true);
    const packetContent = readFileSync(packetAbsolutePath, 'utf-8');
    expect(packetContent).toContain('Task packet: v1');
    expect(packetContent).toContain('truncated=true');
    expect(packetContent).toContain('...[truncated by context budget gate]');
    expect(packetContent).not.toContain(longTailMarker);
  });

  it('sanitizes packet artifact filename when worker instance id contains unsafe characters', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '1';
    process.env.AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS = '900';
    process.env.AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS = '450';
    process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const tempProjectPath = mkdtempSync(join(tmpdir(), 'mudcode-orch-packet-safe-'));
    tempDirs.push(tempProjectPath);
    const now = new Date();
    const unsafeWorkerId = 'codex/unsafe:2';
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        projectName: 'demo',
        projectPath: tempProjectPath,
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
          [unsafeWorkerId]: {
            instanceId: unsafeWorkerId,
            agentType: 'codex',
            tmuxWindow: 'demo-codex-unsafe',
            channelId: 'ch-2',
            eventHook: false,
          },
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    await callback(
      'codex',
      ['continue', '- heavy packet for artifact mode', 'Z'.repeat(1200)].join('\n'),
      'demo',
      'ch-1',
      'msg-1',
      'codex',
    );

    const workerCalls = tmux.typeKeysToWindow.mock.calls.filter((call: unknown[]) => call[1] === 'demo-codex-unsafe');
    expect(workerCalls.length).toBeGreaterThan(0);
    const workerPrompt = String(workerCalls[0]?.[2] || '');
    const match = workerPrompt.match(/Task packet file:\s+([^\n]+)/);
    expect(match?.[1]).toBeTruthy();
    const packetRelativePath = String(match?.[1] || '').trim();
    expect(packetRelativePath).toMatch(/^\.mudcode\/orchestrator\/packets\//);
    expect(packetRelativePath).toMatch(/-codex_unsafe_2\.md$/);
    const packetAbsolutePath = join(tempProjectPath, packetRelativePath);
    expect(existsSync(packetAbsolutePath)).toBe(true);
    const packetContent = readFileSync(packetAbsolutePath, 'utf-8');
    expect(packetContent).toContain('Task packet: v1');
  });

  it('dispatches worker task from supervisor via /orchestrator run', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 implement event queue', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex-2',
      'implement event queue',
      'codex',
    );
    expect(tmux.sendEnterToWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex-2', 'codex');
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-2',
      expect.stringMatching(/^orch-demo-codex-codex-2-/),
      'codex-2',
      'implement event queue',
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Dispatched to worker `codex-2`'),
    );
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents list', 'demo', 'ch-1', 'msg-2', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('recent: dispatched'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('task: implement event queue'),
    );
  });

  it('enforces delegation contract wrapper for /orchestrator run when mode=enforce', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_DELEGATION_CONTRACT_MODE = 'enforce';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 implement event queue', 'demo', 'ch-1', 'msg-1', 'codex');

    const workerPrompt = String(
      tmux.typeKeysToWindow.mock.calls.find((call: unknown[]) => call[1] === 'demo-codex-2')?.[2] || '',
    );
    expect(workerPrompt).toContain('[mudcode delegation-contract]');
    expect(workerPrompt).toContain('project=demo');
    expect(workerPrompt).toContain('supervisor=codex');
    expect(workerPrompt).toContain('worker=codex-2');
    expect(workerPrompt).toContain('implement event queue');
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-2',
      expect.stringMatching(/^orch-demo-codex-codex-2-/),
      'codex-2',
      expect.stringContaining('[mudcode delegation-contract]'),
    );
  });

  it('dispatches worker task via /subagents send alias', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents send codex-2 --priority high implement alias path', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex-2',
      'implement alias path',
      'codex',
    );
    expect(pendingTracker.markPending).toHaveBeenCalledWith(
      'demo',
      'codex',
      'ch-2',
      expect.stringMatching(/^orch-demo-codex-codex-2-/),
      'codex-2',
      'implement alias path',
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Dispatched to worker `codex-2`'),
    );
  });

  it('dispatches worker task via /subagents steer alias', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents steer #1 guide this worker', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex-2',
      'guide this worker',
      'codex',
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Dispatched to worker `codex-2`'),
    );
  });

  it('shows worker runtime details via /subagents info with index token', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('idle'),
      sessionExistsFull: vi.fn().mockReturnValue(true),
      windowExists: vi.fn().mockReturnValue(true),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({
        pendingDepth: 1,
        oldestStage: 'processing',
        oldestAgeMs: 4200,
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents info #1', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('🧩 Subagent `codex-2`'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('runtime status: 🟡 working'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('recent orchestrator task: (none)'),
    );
  });

  it('shows worker tmux tail via /subagents log', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue(['line 1', 'line 2', 'line 3'].join('\n')),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents log codex-2 40', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('📜 Subagent log `demo/codex-2`'),
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('line 3'),
    );
  });

  it('removes all workers via /subagents kill all alias', async () => {
    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    let projectState = {
      ...createMultiInstanceProjectState(),
      instances: {
        ...createMultiInstanceProjectState().instances,
        'codex-3': {
          instanceId: 'codex-3',
          agentType: 'codex',
          tmuxWindow: 'demo-codex-3',
          channelId: 'ch-3',
          eventHook: false,
        },
      },
      orchestrator: {
        enabled: true,
        supervisorInstanceId: 'codex',
        workerInstanceIds: ['codex-2', 'codex-3'],
        workerFinalVisibility: 'hidden',
      },
    };
    const stateManager = {
      getProject: vi.fn().mockImplementation(() => projectState),
      setProject: vi.fn().mockImplementation((next) => {
        projectState = next;
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
    const orchestratorWorkerProvisioner = {
      spawnCodexWorkers: vi.fn(),
      teardownWorker: vi.fn().mockImplementation(async ({ workerInstanceId }: { workerInstanceId: string }) => {
        const removed = projectState.instances?.[workerInstanceId];
        const nextInstances = { ...(projectState.instances || {}) };
        delete nextInstances[workerInstanceId];
        projectState = {
          ...projectState,
          instances: nextInstances,
        };
        return {
          removed: true,
          removedInstance: removed,
        };
      }),
    } as any;

    const router = new BridgeMessageRouter({
      messaging,
      tmux,
      stateManager,
      pendingTracker,
      sanitizeInput: (content) => content,
      orchestratorWorkerProvisioner,
    });
    router.register();

    const callback = getCallback();
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/subagents kill all', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(orchestratorWorkerProvisioner.teardownWorker).toHaveBeenCalledTimes(2);
    expect(orchestratorWorkerProvisioner.teardownWorker).toHaveBeenCalledWith({
      projectName: 'demo',
      workerInstanceId: 'codex-2',
    });
    expect(orchestratorWorkerProvisioner.teardownWorker).toHaveBeenCalledWith({
      projectName: 'demo',
      workerInstanceId: 'codex-3',
    });
    expect(projectState.orchestrator?.workerInstanceIds || []).toHaveLength(0);
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Removed worker instance(s): `codex-2`, `codex-3`'),
    );
  });

  it('queues worker task when worker is busy and dispatches after queue drain', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS = '50';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    let workerPendingDepth = 1;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockImplementation((projectName: string, agentType: string, instanceId?: string) => {
        if (projectName === 'demo' && agentType === 'codex' && instanceId === 'codex-2') {
          if (workerPendingDepth > 0) {
            workerPendingDepth -= 1;
            return { pendingDepth: 1 };
          }
          return { pendingDepth: 0 };
        }
        return { pendingDepth: 0 };
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 queued work', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Queued for worker `codex-2`'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex-2',
      'queued work',
      'codex',
    );
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Dispatched queued task to worker `codex-2`'),
    );
  });

  it('prioritizes high-priority orchestrator tasks in worker queue', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS = '50';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    let workerPendingDepth = 1;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockImplementation((projectName: string, agentType: string, instanceId?: string) => {
        if (projectName === 'demo' && agentType === 'codex' && instanceId === 'codex-2') {
          return { pendingDepth: workerPendingDepth };
        }
        return { pendingDepth: 0 };
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 --priority low low priority task', 'demo', 'ch-1', 'msg-1', 'codex');
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 --priority high high priority task', 'demo', 'ch-1', 'msg-2', 'codex');

    workerPendingDepth = 0;
    await new Promise((resolve) => setTimeout(resolve, 160));

    const dispatchedPrompts = tmux.typeKeysToWindow.mock.calls
      .filter((call: unknown[]) => call[1] === 'demo-codex-2')
      .map((call: unknown[]) => call[2]);
    expect(dispatchedPrompts[0]).toBe('high priority task');
    expect(dispatchedPrompts[1]).toBe('low priority task');
  });

  it('enforces orchestrator max concurrent workers by queuing additional worker dispatches', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
    process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS = '50';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        instances: {
          ...createMultiInstanceProjectState().instances,
          'codex-3': {
            instanceId: 'codex-3',
            agentType: 'codex',
            tmuxWindow: 'demo-codex-3',
            channelId: 'ch-3',
            eventHook: false,
          },
        },
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2', 'codex-3'],
          workerFinalVisibility: 'hidden',
          qos: {
            maxConcurrentWorkers: 1,
          },
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    let worker2Busy = true;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockImplementation((projectName: string, agentType: string, instanceId?: string) => {
        if (projectName === 'demo' && agentType === 'codex' && instanceId === 'codex-2') {
          return { pendingDepth: worker2Busy ? 1 : 0 };
        }
        return { pendingDepth: 0 };
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-3 qos queued task', 'demo', 'ch-1', 'msg-1', 'codex');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('Queued for worker `codex-3`'),
    );
    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();

    worker2Busy = false;
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(tmux.typeKeysToWindow).toHaveBeenCalledWith(
      'agent-demo',
      'demo-codex-3',
      'qos queued task',
      'codex',
    );
  });

  it('drops queued worker task on orchestrator queue timeout', async () => {
    vi.useFakeTimers();
    try {
      process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
      process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
      process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS = '50';
      process.env.AGENT_DISCORD_ORCHESTRATOR_QUEUE_WAIT_TIMEOUT_MS = '1000';

      const { messaging, getCallback } = createMessagingMock();
      const tmux = {
        getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
        capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
        typeKeysToWindow: vi.fn(),
        sendEnterToWindow: vi.fn(),
        sendKeysToWindow: vi.fn(),
        sendRawKeyToWindow: vi.fn(),
      } as any;
      const stateManager = {
        getProject: vi.fn().mockReturnValue({
          ...createMultiInstanceProjectState(),
          orchestrator: {
            enabled: true,
            supervisorInstanceId: 'codex',
            workerInstanceIds: ['codex-2'],
            workerFinalVisibility: 'hidden',
          },
        }),
        setProject: vi.fn(),
        updateLastActive: vi.fn(),
      } as any;
      const pendingTracker = {
        getRuntimeSnapshot: vi.fn().mockImplementation((projectName: string, agentType: string, instanceId?: string) => {
          if (projectName === 'demo' && agentType === 'codex' && instanceId === 'codex-2') {
            return { pendingDepth: 1 };
          }
          return { pendingDepth: 0 };
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
      process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
      await callback('codex', '/orchestrator run codex-2 timeout work', 'demo', 'ch-1', 'msg-1', 'codex');
      await vi.advanceTimersByTimeAsync(1200);

      expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
      expect(messaging.sendToChannel).toHaveBeenCalledWith(
        'ch-1',
        expect.stringContaining('Orchestrator queue timeout: dropped worker task'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects /orchestrator run from non-supervisor instance', async () => {
    process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
    process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';

    const { messaging, getCallback } = createMessagingMock();
    const tmux = {
      getPaneCurrentCommand: vi.fn().mockReturnValue('codex'),
      capturePaneFromWindow: vi.fn().mockReturnValue('Esc to interrupt'),
      typeKeysToWindow: vi.fn(),
      sendEnterToWindow: vi.fn(),
      sendKeysToWindow: vi.fn(),
      sendRawKeyToWindow: vi.fn(),
    } as any;
    const stateManager = {
      getProject: vi.fn().mockReturnValue({
        ...createMultiInstanceProjectState(),
        orchestrator: {
          enabled: true,
          supervisorInstanceId: 'codex',
          workerInstanceIds: ['codex-2'],
          workerFinalVisibility: 'hidden',
        },
      }),
      setProject: vi.fn(),
      updateLastActive: vi.fn(),
    } as any;
    const pendingTracker = {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ pendingDepth: 0 }),
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
    process.env.AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS = '1';
    await callback('codex', '/orchestrator run codex-2 blocked', 'demo', 'ch-2', 'msg-1', 'codex-2');

    expect(tmux.typeKeysToWindow).not.toHaveBeenCalled();
    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-2',
      expect.stringContaining('Only supervisor `codex` can dispatch worker tasks'),
    );
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

    expect(tmux.capturePaneFromWindow).toHaveBeenCalledWith('agent-demo', 'demo-codex', 'codex', 120);
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

  it('routes long /snapshot payload to long-output thread delivery when available', async () => {
    process.env.AGENT_DISCORD_SNAPSHOT_TAIL_LINES = '120';
    process.env.AGENT_DISCORD_SNAPSHOT_LONG_OUTPUT_THREAD_THRESHOLD = '1200';

    const { messaging, getCallback } = createMessagingMock();
    const longSnapshot = Array.from({ length: 140 }, (_, i) => `${String(i + 1).padStart(3, '0')} ${'x'.repeat(32)}`).join('\n');
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

    expect(messaging.sendLongOutput).toHaveBeenCalledWith(
      'ch-1',
      expect.stringContaining('📸 Snapshot `demo/codex`'),
    );
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
