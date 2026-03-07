/**
 * Tests for AgentBridge main class
 */

const pluginInstallerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/opencode/plugin.ts'),
  installClaudePlugin: vi.fn().mockReturnValue('/mock/claude/plugin'),
  installGeminiHook: vi.fn().mockReturnValue('/mock/gemini/hook.js'),
}));

vi.mock('../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: pluginInstallerMocks.installOpencodePlugin,
}));

vi.mock('../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: pluginInstallerMocks.installClaudePlugin,
}));

vi.mock('../src/gemini/hook-installer.js', () => ({
  installGeminiHook: pluginInstallerMocks.installGeminiHook,
}));

import { AgentBridge } from '../src/index.js';
import type { IStateManager } from '../src/types/interfaces.js';
import type { BridgeConfig, ProjectState } from '../src/types/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock helpers
function createMockConfig(): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'agent-' },
    hookServerPort: 19999,
  };
}

function createMockStateManager(): IStateManager {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn().mockReturnValue('guild-123'),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn().mockReturnValue('workspace-123'),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function createMockMessaging() {
  return {
    platform: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    registerChannelMappings: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    getGuilds: vi.fn().mockReturnValue([]),
    getChannelMapping: vi.fn().mockReturnValue(new Map()),
    createAgentChannels: vi.fn().mockResolvedValue({ claude: 'ch-123' }),
    deleteChannel: vi.fn(),
    sendApprovalRequest: vi.fn(),
    sendQuestionWithButtons: vi.fn(),
    setTargetChannel: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

function createMockTmux() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-test'),
    createWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    getPaneCurrentCommand: vi.fn().mockReturnValue('claude'),
    capturePaneFromWindow: vi.fn(),
    startAgentInWindow: vi.fn(),
    setSessionEnv: vi.fn(),
    sessionExistsFull: vi.fn().mockReturnValue(true),
    windowExists: vi.fn().mockReturnValue(false),
    killWindow: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    sendKeys: vi.fn(),
    capturePane: vi.fn(),
    sessionExists: vi.fn(),
    listWindows: vi.fn(),
  } as any;
}

function createMockRegistry() {
  const mockAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    getStartCommand: vi.fn().mockReturnValue('cd "/test" && claude'),
    matchesChannel: vi.fn(),
    isInstalled: vi.fn().mockReturnValue(true),
  };
  return {
    get: vi.fn().mockReturnValue(mockAdapter),
    getAll: vi.fn().mockReturnValue([mockAdapter]),
    register: vi.fn(),
    getByChannelSuffix: vi.fn(),
    parseChannelName: vi.fn(),
    _mockAdapter: mockAdapter,
  } as any;
}

afterEach(() => {
  delete process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS;
  delete process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER;
  delete process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER_PROMPT_MAX_CHARS;
  delete process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE;
});

describe('AgentBridge', () => {
  beforeEach(() => {
    pluginInstallerMocks.installOpencodePlugin.mockClear();
    pluginInstallerMocks.installClaudePlugin.mockClear();
    pluginInstallerMocks.installGeminiHook.mockClear();
  });

  describe('sanitizeInput', () => {
    it('returns null for empty string', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge.sanitizeInput('   \t\n  ')).toBeNull();
    });

    it('returns null for string > 10000 chars', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const longString = 'a'.repeat(10001);
      expect(bridge.sanitizeInput(longString)).toBeNull();
    });

    it('strips null bytes', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const input = 'hello\0world\0test';
      expect(bridge.sanitizeInput(input)).toBe('helloworldtest');
    });

    it('returns valid content unchanged', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      const validContent = 'This is valid content with unicode 한글 emojis 🚀';
      expect(bridge.sanitizeInput(validContent)).toBe(validContent);
    });

    it('shadow mode logs refined candidate but keeps original sanitized output', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-shadow-'));
      const logPath = join(tempDir, 'prompt-refiner-shadow.jsonl');
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: {
          ...createMockConfig(),
          promptRefiner: {
            mode: 'shadow',
            logPath,
          },
        },
      });

      const input = 'line one  \r\n\r\n\r\nline two\t';
      expect(bridge.sanitizeInput(input)).toBe(input);

      const line = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(line);
      expect(entry.mode).toBe('shadow');
      expect(entry.changed).toBe(true);
      expect(entry.baseline).toBe(input);
      expect(entry.candidate).toBe('line one\n\nline two');

      rmSync(tempDir, { recursive: true, force: true });
    });

    it('enforce mode returns refined candidate output', () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: {
          ...createMockConfig(),
          promptRefiner: {
            mode: 'enforce',
          },
        },
      });

      const input = 'line one  \r\n\r\n\r\nline two\t';
      expect(bridge.sanitizeInput(input)).toBe('line one\n\nline two');
    });

    it('enforce mode applies policy file operations when policy path is configured', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'mudcode-policy-'));
      const logPath = join(tempDir, 'prompt-refiner-shadow.jsonl');
      const policyPath = join(tempDir, 'best-system-prompt.txt');
      writeFileSync(
        policyPath,
        [
          'You are a prompt refiner.',
          'Rules:',
          '- Collapse consecutive spaces.',
          '- Remove duplicate punctuation.',
          '- Trim leading/trailing whitespace.',
        ].join('\n'),
        'utf-8',
      );

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: {
          ...createMockConfig(),
          promptRefiner: {
            mode: 'enforce',
            logPath,
            policyPath,
          },
        },
      });

      const input = '  hello   world!!  ';
      expect(bridge.sanitizeInput(input)).toBe('hello world!');

      const line = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(line);
      expect(entry.policyPath).toBe(policyPath);
      expect(entry.policyOperations).toEqual(
        expect.arrayContaining([
          'collapse_consecutive_spaces',
          'remove_duplicate_punctuation',
          'trim_outer_whitespace',
        ]),
      );

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('constructor', () => {
    it('creates with all dependencies injected', () => {
      const mockMessaging = createMockMessaging();
      const mockTmux = createMockTmux();
      const mockStateManager = createMockStateManager();
      const mockRegistry = createMockRegistry();
      const mockConfig = createMockConfig();

      const bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: mockConfig,
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
    });

    it('creates with mocked dependencies', () => {
      // Just verify the class is constructable with mocked deps
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      expect(bridge).toBeInstanceOf(AgentBridge);
      expect(typeof bridge.sanitizeInput).toBe('function');
    });
  });

  describe('start', () => {
    let bridge: AgentBridge;
    let mockMessaging: any;
    let mockStateManager: any;

    beforeEach(() => {
      mockMessaging = createMockMessaging();
      mockStateManager = createMockStateManager();
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: createMockTmux(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });
    });

    afterEach(async () => {
      await bridge.stop();
    });

    it('connects messaging client and registers channel mappings from state', async () => {
      const projects: ProjectState[] = [
        {
          projectName: 'test-project',
          projectPath: '/test',
          tmuxSession: 'agent-test',
          discordChannels: { claude: 'ch-123', cursor: 'ch-456' },
          agents: { claude: true },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      ];
      mockStateManager.listProjects.mockReturnValue(projects);

      await bridge.start();

      expect(mockMessaging.connect).toHaveBeenCalledOnce();
      expect(mockMessaging.registerChannelMappings).toHaveBeenCalledWith([
        { channelId: 'ch-123', projectName: 'test-project', agentType: 'claude', instanceId: 'claude' },
        { channelId: 'ch-456', projectName: 'test-project', agentType: 'cursor', instanceId: 'cursor' },
      ]);
    });

    it('sets up message callback via messaging.onMessage', async () => {
      await bridge.start();

      expect(mockMessaging.onMessage).toHaveBeenCalledOnce();
      expect(mockMessaging.onMessage).toHaveBeenCalledWith(expect.any(Function));
    });

    it('wires /repair mapping reload through project bootstrap dependency chain', async () => {
      const projects: ProjectState[] = [
        {
          projectName: 'test-project',
          projectPath: '/test',
          tmuxSession: 'agent-test',
          discordChannels: { claude: 'ch-123' },
          agents: { claude: true },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      ];
      mockStateManager.listProjects.mockReturnValue(projects);
      mockStateManager.getProject.mockReturnValue(projects[0]);

      await bridge.start();
      const cb = mockMessaging.onMessage.mock.calls[0][0];

      mockStateManager.reload.mockClear();
      mockStateManager.listProjects.mockClear();
      mockMessaging.registerChannelMappings.mockClear();

      await cb('claude', '/repair mapping', 'test-project', 'ch-123', 'msg-repair-map', 'claude');

      expect(mockStateManager.reload).toHaveBeenCalledOnce();
      expect(mockStateManager.listProjects).toHaveBeenCalledOnce();
      expect(mockMessaging.registerChannelMappings).toHaveBeenCalledWith([
        { channelId: 'ch-123', projectName: 'test-project', agentType: 'claude', instanceId: 'claude' },
      ]);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        '✅ Reloaded channel mappings from state (`/repair mapping`).',
      );

      const reloadOrder = mockStateManager.reload.mock.invocationCallOrder[0];
      const listOrder = mockStateManager.listProjects.mock.invocationCallOrder[0];
      const registerOrder = mockMessaging.registerChannelMappings.mock.invocationCallOrder[0];
      expect(reloadOrder).toBeLessThan(listOrder);
      expect(listOrder).toBeLessThan(registerOrder);
    });

    it('marks claude projects as event-hook driven after plugin install', async () => {
      const projects: ProjectState[] = [
        {
          projectName: 'test-project',
          projectPath: '/test',
          tmuxSession: 'agent-test',
          discordChannels: { claude: 'ch-123' },
          agents: { claude: true },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      ];
      mockStateManager.listProjects.mockReturnValue(projects);

      await bridge.start();

      expect(pluginInstallerMocks.installClaudePlugin).toHaveBeenCalledWith('/test');
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          eventHooks: expect.objectContaining({ claude: true }),
        })
      );
    });

    it('marks gemini projects as event-hook driven after hook install', async () => {
      const projects: ProjectState[] = [
        {
          projectName: 'test-project',
          projectPath: '/test',
          tmuxSession: 'agent-test',
          discordChannels: { gemini: 'ch-123' },
          agents: { gemini: true },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      ];
      mockStateManager.listProjects.mockReturnValue(projects);

      await bridge.start();

      expect(pluginInstallerMocks.installGeminiHook).toHaveBeenCalledWith('/test');
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          eventHooks: expect.objectContaining({ gemini: true }),
        })
      );
    });

    it('uses reactions instead of received/completed status messages', async () => {
      const mockTmux = createMockTmux();
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      mockStateManager.getProject.mockReturnValue({
        projectName: 'test-project',
        projectPath: '/test',
        tmuxSession: 'agent-test',
        discordChannels: { claude: 'ch-123' },
        agents: { claude: true },
        createdAt: new Date(),
        lastActive: new Date(),
      });

      await bridge.start();
      const cb = mockMessaging.onMessage.mock.calls[0][0];
      await cb('claude', 'hello', 'test-project', 'ch-123', 'msg-1');

      expect(mockMessaging.addReactionToMessage).toHaveBeenCalledWith('ch-123', 'msg-1', '📥');
      const statusMessages = mockMessaging.sendToChannel.mock.calls
        .map((c: any[]) => String(c[1] ?? ''))
        .filter((msg) => msg.includes('받은 메시지') || msg.includes('✅ 작업 완료'));
      expect(statusMessages).toHaveLength(0);
    });

    it('submits opencode via type-then-enter with short delay', async () => {
      process.env.AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS = '0';

      const mockTmux = createMockTmux();
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      mockStateManager.getProject.mockReturnValue({
        projectName: 'test-project',
        projectPath: '/test',
        tmuxSession: 'agent-test',
        tmuxWindows: { opencode: 'test-project-opencode' },
        discordChannels: { opencode: 'ch-123' },
        agents: { opencode: true },
        createdAt: new Date(),
        lastActive: new Date(),
      });

      await bridge.start();
      const cb = mockMessaging.onMessage.mock.calls[0][0];
      await cb('opencode', 'hello opencode', 'test-project', 'ch-123');

      expect(mockTmux.typeKeysToWindow).toHaveBeenCalledWith('agent-test', 'test-project-opencode', 'hello opencode', 'opencode');
      expect(mockTmux.sendEnterToWindow).toHaveBeenCalledWith('agent-test', 'test-project-opencode', 'opencode');
      expect(mockTmux.sendKeysToWindow).not.toHaveBeenCalled();
    });

    it('queues automatic retry when tmux window is missing', async () => {
      process.env.AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS = '0';

      const mockTmux = createMockTmux();
      mockTmux.typeKeysToWindow.mockImplementation(() => {
        throw new Error(
          "Failed to type keys to window 'mudcode-opencode' in session 'bridge': Command failed: tmux send-keys -t 'bridge:mudcode-opencode' 'hi'\ncan't find window: mudcode-opencode",
        );
      });
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      mockStateManager.getProject.mockReturnValue({
        projectName: 'mudcode',
        projectPath: '/test',
        tmuxSession: 'bridge',
        tmuxWindows: { opencode: 'mudcode-opencode' },
        discordChannels: { opencode: 'ch-123' },
        agents: { opencode: true },
        createdAt: new Date(),
        lastActive: new Date(),
      });

      await bridge.start();
      const cb = mockMessaging.onMessage.mock.calls[0][0];
      await cb('opencode', 'hi', 'mudcode', 'ch-123');

      const lastNotice = String(mockMessaging.sendToChannel.mock.calls.at(-1)?.[1] ?? '');
      expect(lastNotice).toContain('queued your message for automatic retry');
      expect(lastNotice).not.toContain("can't find window");
    });

    it('auto-spawns workers and planner-dispatches without manual orchestrator setup', async () => {
      process.env.AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS = '0';
      process.env.AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS = '0';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE = '1';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE = 'continue';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS = '2';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN = '1';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS = '2';
      process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER = '1';
      process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE = 'off';

      const mockTmux = createMockTmux();
      mockTmux.getPaneCurrentCommand.mockReturnValue('codex');
      mockTmux.capturePaneFromWindow.mockReturnValue('Esc to interrupt');
      mockTmux.sessionExistsFull.mockReturnValue(true);

      const now = new Date();
      let projectState: ProjectState = {
        projectName: 'demo',
        projectPath: '/demo',
        tmuxSession: 'agent-demo',
        discordChannels: { codex: 'ch-1' },
        agents: { codex: true },
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

      const customStateManager = createMockStateManager();
      customStateManager.getProject = vi.fn().mockImplementation((name: string) => (
        name === 'demo' ? projectState : undefined
      ));
      customStateManager.listProjects = vi.fn().mockImplementation(() => [projectState]);
      customStateManager.setProject = vi.fn().mockImplementation((next: ProjectState) => {
        projectState = next;
      });

      const codexAdapter = {
        config: { name: 'codex', displayName: 'Codex', command: 'codex', channelSuffix: 'codex' },
        getStartCommand: vi.fn().mockReturnValue('cd "/demo" && codex'),
        matchesChannel: vi.fn(),
        isInstalled: vi.fn().mockReturnValue(true),
      };
      const customRegistry = {
        get: vi.fn((name: string) => (name === 'codex' ? codexAdapter : undefined)),
        getAll: vi.fn().mockReturnValue([codexAdapter]),
        register: vi.fn(),
        getByChannelSuffix: vi.fn(),
        parseChannelName: vi.fn(),
      } as any;

      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: customStateManager,
        registry: customRegistry,
        config: createMockConfig(),
      });

      await bridge.start();
      const cb = mockMessaging.onMessage.mock.calls[0][0];
      await cb(
        'codex',
        [
          'continue',
          '- inspect event-contract regressions',
          '- implement fixes',
          '- update tests',
        ].join('\n'),
        'demo',
        'ch-1',
        'msg-1',
        'codex',
      );

      expect(projectState.orchestrator?.enabled).toBe(true);
      expect(projectState.orchestrator?.workerInstanceIds).toEqual(
        expect.arrayContaining(['codex-2', 'codex-3']),
      );
      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-demo',
        'demo-codex-2',
        expect.stringContaining("AGENT_DISCORD_INSTANCE='codex-2'"),
      );
      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-demo',
        'demo-codex-3',
        expect.stringContaining("AGENT_DISCORD_INSTANCE='codex-3'"),
      );

      const workerDispatchCalls = mockTmux.typeKeysToWindow.mock.calls.filter((call: any[]) =>
        call[1] === 'demo-codex-2' || call[1] === 'demo-codex-3',
      );
      expect(workerDispatchCalls).toHaveLength(2);
      expect(String(workerDispatchCalls[0]?.[2] || '')).toContain('[mudcode orchestrator-plan]');
      expect(String(workerDispatchCalls[1]?.[2] || '')).toContain('[mudcode orchestrator-plan]');

      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-1',
        expect.stringContaining('Auto worker provisioned'),
      );
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-1',
        expect.stringContaining('Auto orchestration fanout (planner)'),
      );
    });
  });

  describe('setupProject', () => {
    let bridge: AgentBridge;
    let mockMessaging: any;
    let mockTmux: any;
    let mockStateManager: any;
    let mockRegistry: any;

    beforeEach(() => {
      mockMessaging = createMockMessaging();
      mockTmux = createMockTmux();
      mockStateManager = createMockStateManager();
      mockRegistry = createMockRegistry();
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: createMockConfig(),
      });
    });

    it('creates tmux session, messaging channel, saves state', async () => {
      const result = await bridge.setupProject(
        'test-project',
        '/test/path',
        { claude: true }
      );
      const generatedChannelName = mockMessaging.createAgentChannels.mock.calls[0]?.[3];

      expect(mockTmux.getOrCreateSession).toHaveBeenCalledWith('bridge', 'test-project-claude');
      expect(mockMessaging.createAgentChannels).toHaveBeenCalledWith(
        'guild-123',
        'test-project',
        [mockRegistry._mockAdapter.config],
        expect.stringMatching(/^test-project-claude-[a-z0-9]{6}$/),
        { claude: 'claude' },
      );
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test-project',
          projectPath: '/test/path',
          tmuxSession: 'agent-test',
          eventHooks: { claude: true },
        })
      );
      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        expect.stringContaining(`--plugin-dir '/mock/claude/plugin'`)
      );
      expect(generatedChannelName).toMatch(/^test-project-claude-[a-z0-9]{6}$/);
      expect(result.channelName).toBe(generatedChannelName);
      expect(result.channelId).toBe('ch-123');
      expect(result.agentName).toBe('Claude Code');
      expect(result.tmuxSession).toBe('agent-test');
    });

    it('sets OPENCODE_PERMISSION env when configured to allow', async () => {
      const opencodeAdapter = {
        config: { name: 'opencode', displayName: 'OpenCode', command: 'opencode', channelSuffix: 'opencode' },
        getStartCommand: vi.fn().mockReturnValue('cd "/missing/project/path" && opencode'),
        matchesChannel: vi.fn(),
        isInstalled: vi.fn().mockReturnValue(true),
      };
      mockRegistry.getAll.mockReturnValue([opencodeAdapter]);
      mockMessaging.createAgentChannels.mockResolvedValue({ opencode: 'ch-op' });

      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: {
          ...createMockConfig(),
          opencode: { permissionMode: 'allow' },
        },
      });

      await bridge.setupProject('test-project', '/missing/project/path', { opencode: true });

      expect(mockTmux.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-opencode',
        expect.stringContaining(`export OPENCODE_PERMISSION='{"*":"allow"}';`)
      );
    });

    it('adds claude skip-permissions flag when permission mode is allow', async () => {
      bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: mockTmux,
        stateManager: mockStateManager,
        registry: mockRegistry,
        config: {
          ...createMockConfig(),
          opencode: { permissionMode: 'allow' },
        },
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(mockRegistry._mockAdapter.getStartCommand).toHaveBeenCalledWith('/test/path', true);
    });

    it('throws when no guild ID configured', async () => {
      mockStateManager.getGuildId.mockReturnValue(undefined);

      await expect(
        bridge.setupProject('test-project', '/test/path', { claude: true })
      ).rejects.toThrow('Server ID not configured');
    });

    it('throws when no agent specified', async () => {
      mockRegistry.getAll.mockReturnValue([]);

      await expect(
        bridge.setupProject('test-project', '/test/path', {})
      ).rejects.toThrow('No agent specified');
    });
  });

  describe('stop', () => {
    it('stops hook server and disconnects messaging client', async () => {
      const mockMessaging = createMockMessaging();
      const bridge = new AgentBridge({
        messaging: mockMessaging,
        tmux: createMockTmux(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      // Start first to create HTTP server
      await bridge.start();

      // Now stop
      await bridge.stop();

      expect(mockMessaging.disconnect).toHaveBeenCalledOnce();
    });
  });
});
