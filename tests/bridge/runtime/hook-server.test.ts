import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../../src/bridge/runtime/hook-server.js';
import type { BridgeHookServerDeps } from '../../../src/bridge/runtime/hook-server.js';

function createMockMessaging(platform: 'discord' | 'slack' = 'slack') {
  return {
    platform,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToProgressThread: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    sendLongOutput: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPendingTracker() {
  return {
    getPendingChannel: vi.fn().mockReturnValue(undefined),
    getPendingDepth: vi.fn().mockReturnValue(0),
    getPendingMessageId: vi.fn().mockReturnValue(undefined),
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markCompletedByMessageId: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    markErrorByMessageId: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockStateManager(projects: Record<string, any> = {}) {
  return {
    getProject: vi.fn((name: string) => projects[name]),
    setProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue(Object.values(projects)),
    reload: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

function postJSON(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getPath(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('BridgeHookServer', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    // Use realpathSync to resolve macOS symlinks (/var → /private/var)
    // so that validateFilePaths' realpathSync check doesn't fail.
    const rawDir = join(tmpdir(), `mudcode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
    // Use a random high port to avoid conflicts
    port = 19000 + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGENT_DISCORD_CODEX_EVENT_ONLY;
    delete process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_STREAMING;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_PROGRESS_TRANSCRIPT_MAX_CHARS;
    delete process.env.AGENT_DISCORD_EVENT_FINAL_FROM_PROGRESS_ON_EMPTY;
    delete process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE;
    delete process.env.AGENT_DISCORD_EVENT_STARTED_TURN_RETENTION_MS;
  });

  function startServer(deps: Partial<BridgeHookServerDeps> = {}): BridgeHookServer {
    const fullDeps: BridgeHookServerDeps = {
      port,
      messaging: createMockMessaging() as any,
      stateManager: createMockStateManager() as any,
      pendingTracker: createMockPendingTracker() as any,
      reloadChannelMappings: vi.fn(),
      ...deps,
    };
    server = new BridgeHookServer(fullDeps);
    server.start();
    return server;
  }

  describe('POST /reload', () => {
    it('calls reloadChannelMappings and returns 200', async () => {
      const reloadFn = vi.fn();
      startServer({ reloadChannelMappings: reloadFn });

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/reload', {});
      expect(res.status).toBe(200);
      expect(res.body).toBe('OK');
      expect(reloadFn).toHaveBeenCalledOnce();
    });
  });

  describe('GET /runtime-status', () => {
    it('returns per-instance runtime snapshots', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      const pendingTracker = createMockPendingTracker() as any;
      pendingTracker.getRuntimeSnapshot = vi.fn().mockReturnValue({
        pendingDepth: 1,
        oldestStage: 'processing',
        oldestAgeMs: 1800,
        latestStage: 'processing',
      });
      startServer({ stateManager: stateManager as any, pendingTracker });
      await new Promise((r) => setTimeout(r, 50));

      const res = await getPath(port, '/runtime-status');
      expect(res.status).toBe(200);

      const payload = JSON.parse(res.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(Array.isArray(payload.instances)).toBe(true);
      expect(payload.instances).toHaveLength(1);
      expect(payload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'claude',
        agentType: 'claude',
        pendingDepth: 1,
        oldestStage: 'processing',
      });
      expect(pendingTracker.getRuntimeSnapshot).toHaveBeenCalledWith('test', 'claude', 'claude');
    });

    it('includes ignored event counters for capture-driven instances', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      const pendingTracker = createMockPendingTracker() as any;
      pendingTracker.getRuntimeSnapshot = vi.fn().mockReturnValue({ pendingDepth: 0 });
      startServer({ stateManager: stateManager as any, pendingTracker });
      await new Promise((r) => setTimeout(r, 50));

      const eventRes = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'codex',
        type: 'session.idle',
        text: 'intermediate',
      });
      expect(eventRes.status).toBe(200);

      const res = await getPath(port, '/runtime-status');
      expect(res.status).toBe(200);

      const payload = JSON.parse(res.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(payload.instances).toHaveLength(1);
      expect(payload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        ignoredEventCount: 1,
      });
      expect((payload.instances[0]?.ignoredEventTypes as Record<string, unknown>)?.['session.idle']).toBe(1);
    });

    it('includes event lifecycle snapshot after agent-event start', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      const pendingTracker = createMockPendingTracker() as any;
      pendingTracker.getRuntimeSnapshot = vi.fn().mockReturnValue({ pendingDepth: 0 });
      startServer({ stateManager: stateManager as any, pendingTracker });
      await new Promise((r) => setTimeout(r, 50));

      const startRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'turn-runtime-1',
        eventId: 'evt-runtime-1',
        type: 'session.start',
        source: 'codex-poc',
      });
      expect(startRes.status).toBe(200);

      const res = await getPath(port, '/runtime-status');
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(payload.instances).toHaveLength(1);
      expect(payload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventLifecycleStage: 'started',
        eventLifecycleTurnId: 'turn-runtime-1',
        eventLifecycleEventId: 'evt-runtime-1',
      });
    });

    it('includes latest progress mode snapshot for instance', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      const pendingTracker = createMockPendingTracker() as any;
      pendingTracker.getRuntimeSnapshot = vi.fn().mockReturnValue({ pendingDepth: 0 });
      startServer({ stateManager: stateManager as any, pendingTracker });
      await new Promise((r) => setTimeout(r, 50));

      const progressRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'turn-runtime-progress-1',
        eventId: 'evt-runtime-progress-1',
        seq: 1,
        type: 'session.progress',
        text: 'progress text',
        progressMode: 'thread',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });
      expect(progressRes.status).toBe(200);

      const res = await getPath(port, '/runtime-status');
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(payload.instances).toHaveLength(1);
      expect(payload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventProgressMode: 'thread',
        eventProgressModeTurnId: 'turn-runtime-progress-1',
      });
      expect(typeof payload.instances[0]?.eventProgressModeAgeMs).toBe('number');
      expect(typeof payload.instances[0]?.eventProgressModeUpdatedAt).toBe('string');
    });
  });

  describe('POST /send-files', () => {
    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { files: ['/tmp/f.png'] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('projectName');
    });

    it('returns 400 for empty files array', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: [] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('No files');
    });

    it('returns 404 for unknown project', async () => {
      startServer({ stateManager: createMockStateManager({}) as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'nonexistent', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('Project not found');
    });

    it('returns 404 when no channel found for project', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: {},
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('No channel');
    });

    it('sends files for valid project with channelId', async () => {
      const filesDir = join(tempDir, '.mudcode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'test.png');
      writeFileSync(testFile, 'fake-png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'test',
        agentType: 'claude',
        files: [testFile],
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Generated file'),
        [testFile],
      );
    });

    it('falls back to default channel when multiple pending requests exist', async () => {
      const filesDir = join(tempDir, '.mudcode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'test-multi.png');
      writeFileSync(testFile, 'fake-png-data');

      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPendingChannel.mockReturnValue('thread-xyz');
      mockPendingTracker.getPendingDepth.mockReturnValue(2);
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'test',
        agentType: 'claude',
        files: [testFile],
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Generated file'),
        [testFile],
      );
    });

    it('rejects files outside the project directory', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      // File outside projectPath
      const outsideFile = join(realpathSync(tmpdir()), 'outside.txt');
      writeFileSync(outsideFile, 'outside');
      try {
        const res = await postJSON(port, '/send-files', {
          projectName: 'test',
          agentType: 'claude',
          files: [outsideFile],
        });
        expect(res.status).toBe(400);
        expect(res.body).toContain('No valid files');
      } finally {
        rmSync(outsideFile, { force: true });
      }
    });
  });

  describe('POST /opencode-event', () => {
    it('ignores codex events when eventHook is disabled', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'codex',
        type: 'session.idle',
        text: 'intermediate text',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
      expect(mockPendingTracker.markError).not.toHaveBeenCalled();
    });

    it('handles codex events when eventHook is explicitly enabled', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'codex',
        type: 'session.idle',
        text: 'final text',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'final text');
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
    });

    it('handles codex POC session.final events via /agent-event even when eventHook is disabled', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        type: 'session.final',
        text: 'final text from codex poc',
        source: 'codex-poc',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'final text from codex poc');
      expect(mockPendingTracker.markCompleted).toHaveBeenCalledWith('test', 'codex', 'codex');
    });

    it('uses turnId-specific completion path when session.final includes turnId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-turn-1',
        type: 'session.final',
        text: 'turn-specific final',
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledWith(
        'test',
        'codex',
        'msg-turn-1',
        'codex',
      );
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
    });

    it('deduplicates repeated events with the same eventId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const payload = {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-turn-dedupe',
        eventId: 'evt-dedupe-1',
        type: 'session.final',
        text: 'dedupe final text',
        source: 'codex-poc',
      };

      const res1 = await postJSON(port, '/agent-event', payload);
      const res2 = await postJSON(port, '/agent-event', payload);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledTimes(1);
    });

    it('does not let ignored events pollute dedupe/sequence state', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const turnId = 'msg-turn-ignore-pollution';
      const ignored = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId,
        eventId: 'evt-ignore-1',
        seq: 9,
        type: 'session.final',
        text: 'ignored final text',
      });
      const accepted = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId,
        eventId: 'evt-accept-1',
        seq: 1,
        type: 'session.final',
        text: 'accepted final text',
        source: 'codex-poc',
      });

      expect(ignored.status).toBe(200);
      expect(accepted.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'accepted final text');
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledWith(
        'test',
        'codex',
        turnId,
        'codex',
      );
    });

    it('skips out-of-order events when sequence decreases for the same turn', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const turnId = 'msg-turn-seq-1';
      const resNew = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId,
        eventId: 'evt-seq-2',
        seq: 2,
        type: 'session.final',
        text: 'newer final text',
        source: 'codex-poc',
      });
      const resOld = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId,
        eventId: 'evt-seq-1',
        seq: 1,
        type: 'session.final',
        text: 'older final text',
        source: 'codex-poc',
      });

      expect(resNew.status).toBe(200);
      expect(resOld.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'newer final text');
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledTimes(1);
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledWith(
        'test',
        'codex',
        turnId,
        'codex',
      );

      const runtimeRes = await getPath(port, '/runtime-status');
      expect(runtimeRes.status).toBe(200);
      const runtimePayload = JSON.parse(runtimeRes.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(runtimePayload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventLifecycleSeq: 2,
      });
    });

    it('accepts session.start via /agent-event without emitting output', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        type: 'session.start',
        source: 'codex-poc',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
      expect(mockPendingTracker.markError).not.toHaveBeenCalled();
    });

    it('rejects terminal events without prior start when strict lifecycle mode is reject', async () => {
      process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE = 'reject';
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const rejected = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-strict-1',
        eventId: 'evt-strict-1',
        seq: 1,
        type: 'session.final',
        text: 'should be dropped',
        source: 'codex-poc',
      });
      expect(rejected.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
      expect(mockPendingTracker.markCompletedByMessageId).not.toHaveBeenCalled();
      const runtimeAfterReject = await getPath(port, '/runtime-status');
      expect(runtimeAfterReject.status).toBe(200);
      const runtimePayloadAfterReject = JSON.parse(runtimeAfterReject.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(runtimePayloadAfterReject.instances[0]).toMatchObject({
        lifecycleRejectedEventCount: 1,
      });
      expect(
        (runtimePayloadAfterReject.instances[0]?.lifecycleRejectedEventTypes as Record<string, unknown>)?.['session.final'],
      ).toBe(1);

      const started = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-strict-1',
        eventId: 'evt-strict-2',
        seq: 2,
        type: 'session.start',
        source: 'codex-poc',
      });
      expect(started.status).toBe(200);

      const accepted = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-strict-1',
        eventId: 'evt-strict-3',
        seq: 3,
        type: 'session.final',
        text: 'accepted after start',
        source: 'codex-poc',
      });
      expect(accepted.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'accepted after start');
    });

    it('accepts session.progress via /agent-event and updates lifecycle without emitting output by default', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-1',
        eventId: 'evt-progress-1',
        seq: 1,
        type: 'session.progress',
        text: 'delta text',
        source: 'codex-poc',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
      expect(mockPendingTracker.markError).not.toHaveBeenCalled();

      const runtimeRes = await getPath(port, '/runtime-status');
      expect(runtimeRes.status).toBe(200);
      const runtimePayload = JSON.parse(runtimeRes.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(runtimePayload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventLifecycleStage: 'progress',
        eventLifecycleTurnId: 'msg-progress-1',
        eventLifecycleEventId: 'evt-progress-1',
        eventLifecycleSeq: 1,
      });
    });

    it('forwards session.progress text to progress thread when enabled', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'thread';
      process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS = '80';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-forward-1',
        eventId: 'evt-progress-forward-1',
        seq: 1,
        type: 'session.progress',
        text: 'partial delta',
        source: 'codex-poc',
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 120));
      expect(mockMessaging.sendToProgressThread).toHaveBeenCalledWith('ch-123', 'partial delta');
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('honors per-event progress override even when env forwarding is off', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'off';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-override-1',
        eventId: 'evt-progress-override-1',
        seq: 1,
        type: 'session.progress',
        text: 'forced thread delta',
        progressMode: 'thread',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).toHaveBeenCalledWith('ch-123', 'forced thread delta');
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('forces channel progress override to thread in codex event-only mode', async () => {
      process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'channel';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-event-only-1',
        eventId: 'evt-progress-event-only-1',
        seq: 1,
        type: 'session.progress',
        text: 'no channel output',
        progressMode: 'channel',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).toHaveBeenCalledWith('ch-123', 'no channel output');
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();

      const runtimeRes = await getPath(port, '/runtime-status');
      expect(runtimeRes.status).toBe(200);
      const runtimePayload = JSON.parse(runtimeRes.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(runtimePayload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventProgressMode: 'thread',
      });
    });

    it('disables progress forwarding when codex event-only is enabled without progress thread support', async () => {
      process.env.AGENT_DISCORD_CODEX_EVENT_ONLY = '1';
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'channel';
      const mockMessaging = createMockMessaging('slack');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-event-only-2',
        eventId: 'evt-progress-event-only-2',
        seq: 1,
        type: 'session.progress',
        text: 'drop progress output',
        progressMode: 'channel',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();

      const runtimeRes = await getPath(port, '/runtime-status');
      expect(runtimeRes.status).toBe(200);
      const runtimePayload = JSON.parse(runtimeRes.body) as {
        instances: Array<Record<string, unknown>>;
      };
      expect(runtimePayload.instances[0]).toMatchObject({
        projectName: 'test',
        instanceId: 'codex',
        eventProgressMode: 'off',
      });
    });

    it('coalesces multiple session.progress events into one block flush', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'thread';
      process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS = '120';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const first = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-coalesce-1',
        eventId: 'evt-progress-coalesce-1',
        seq: 1,
        type: 'session.progress',
        text: 'line one',
        source: 'codex-poc',
      });
      const second = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-coalesce-1',
        eventId: 'evt-progress-coalesce-2',
        seq: 2,
        type: 'session.progress',
        text: 'line two',
        source: 'codex-poc',
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 180));

      expect(mockMessaging.sendToProgressThread).toHaveBeenCalledTimes(1);
      const sent = mockMessaging.sendToProgressThread.mock.calls[0]?.[1] as string;
      expect(sent).toContain('line one');
      expect(sent).toContain('line two');
    });

    it('drops buffered progress block when session.final arrives before flush', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'thread';
      process.env.AGENT_DISCORD_EVENT_PROGRESS_BLOCK_WINDOW_MS = '200';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const progressRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-drop-1',
        eventId: 'evt-progress-drop-1',
        seq: 1,
        type: 'session.progress',
        text: 'will be dropped',
        source: 'codex-poc',
      });
      const finalRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-drop-1',
        eventId: 'evt-progress-drop-2',
        seq: 2,
        type: 'session.final',
        text: 'final answer',
        source: 'codex-poc',
      });

      expect(progressRes.status).toBe(200);
      expect(finalRes.status).toBe(200);
      await new Promise((r) => setTimeout(r, 260));

      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'final answer');
    });

    it('uses accumulated progress transcript when session.final text is empty', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'off';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const progressOne = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-transcript-1',
        eventId: 'evt-progress-transcript-1',
        seq: 1,
        type: 'session.progress',
        text: 'line one',
        source: 'codex-poc',
      });
      const progressTwo = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-transcript-1',
        eventId: 'evt-progress-transcript-2',
        seq: 2,
        type: 'session.progress',
        text: 'line two',
        source: 'codex-poc',
      });
      const finalRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-transcript-1',
        eventId: 'evt-progress-transcript-3',
        seq: 3,
        type: 'session.final',
        text: '',
        source: 'codex-poc',
      });

      expect(progressOne.status).toBe(200);
      expect(progressTwo.status).toBe(200);
      expect(finalRes.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      const delivered = String(mockMessaging.sendToChannel.mock.calls[0]?.[1] || '');
      expect(delivered).toContain('line one');
      expect(delivered).toContain('line two');
    });

    it('does not duplicate transcript fallback when per-turn progress mode is channel', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'off';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const progressRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-channel-override-1',
        eventId: 'evt-progress-channel-override-1',
        seq: 1,
        type: 'session.progress',
        text: 'already delivered via channel',
        progressMode: 'channel',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });
      const finalRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-channel-override-1',
        eventId: 'evt-progress-channel-override-2',
        seq: 2,
        type: 'session.final',
        text: '',
        source: 'codex-poc',
      });

      expect(progressRes.status).toBe(200);
      expect(finalRes.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'already delivered via channel');
      expect(mockMessaging.sendToProgressThread).not.toHaveBeenCalled();
    });

    it('uses transcript fallback for per-turn thread override even when global progress mode is channel', async () => {
      process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD = 'channel';
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: true },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const progressRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-thread-override-1',
        eventId: 'evt-progress-thread-override-1',
        seq: 1,
        type: 'session.progress',
        text: 'thread only delta',
        progressMode: 'thread',
        progressBlockStreaming: false,
        source: 'codex-poc',
      });
      const finalRes = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-progress-thread-override-1',
        eventId: 'evt-progress-thread-override-2',
        seq: 2,
        type: 'session.final',
        text: '',
        source: 'codex-poc',
      });

      expect(progressRes.status).toBe(200);
      expect(finalRes.status).toBe(200);
      expect(mockMessaging.sendToProgressThread).toHaveBeenCalledWith('ch-123', 'thread only delta');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(String(mockMessaging.sendToChannel.mock.calls[0]?.[1] || '')).toContain('thread only delta');
    });

    it('handles session.idle with text', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Hello from agent');
    });

    it('formats multiline session.idle output for discord', async () => {
      const mockMessaging = createMockMessaging('discord');
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'line1\nline2',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'line1\nline2');
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
    });

    it('marks pending as error when session.idle delivery fails', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.sendToChannel.mockRejectedValue(new Error('send failed'));
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
      });

      expect(res.status).toBe(500);
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
      expect(mockPendingTracker.markError).toHaveBeenCalled();
    });

    it('uses pending channel override for session.idle output', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPendingChannel.mockReturnValue('thread-xyz');
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello in thread',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.getPendingChannel).toHaveBeenCalledWith('test', 'claude', 'claude');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('thread-xyz', 'Hello in thread');
    });

    it('falls back to default channel for session.idle when multiple pending requests exist', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPendingChannel.mockReturnValue('thread-xyz');
      mockPendingTracker.getPendingDepth.mockReturnValue(2);
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello in parent',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Hello in parent');
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
    });

    it('uses threaded long-output delivery on discord for oversized session.idle text', async () => {
      const mockMessaging = createMockMessaging('discord');
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longText = 'x'.repeat(2400);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: longText,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendLongOutput).toHaveBeenCalledWith('ch-123', longText);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('auto-clamps legacy long-output threshold env value for threaded delivery', async () => {
      process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD = '100000';
      const mockMessaging = createMockMessaging('discord');
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longText = 'x'.repeat(25000);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: longText,
      });

      expect(res.status).toBe(200);
      expect(mockMessaging.sendLongOutput).toHaveBeenCalledWith('ch-123', longText);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('strips file paths from display text in session.idle', async () => {
      const filesDir = join(tempDir, '.mudcode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const textWithPath = `Here is the output: ${testFile}`;
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: textWithPath,
      });
      expect(res.status).toBe(200);

      // The sent text should not contain the file path
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      expect(sentText).toContain('Here is the output:');

      // File should be sent separately
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Generated file'),
        [testFile],
      );
    });

    it('handles session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something went wrong',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markError).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Something went wrong'),
      );
    });

    it('uses turnId-specific error path when session.error includes turnId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-turn-2',
        type: 'session.error',
        text: 'turn-specific error',
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockPendingTracker.markErrorByMessageId).toHaveBeenCalledWith(
        'test',
        'codex',
        'msg-turn-2',
        'codex',
      );
      expect(mockPendingTracker.markError).not.toHaveBeenCalled();
    });

    it('handles session.cancelled and clears pending for the turnId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { codex: true },
          discordChannels: { codex: 'ch-123' },
          instances: {
            codex: { instanceId: 'codex', agentType: 'codex', channelId: 'ch-123', eventHook: false },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/agent-event', {
        projectName: 'test',
        agentType: 'codex',
        instanceId: 'codex',
        turnId: 'msg-turn-cancel',
        type: 'session.cancelled',
        text: 'user interrupted',
        source: 'codex-poc',
      });

      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompletedByMessageId).toHaveBeenCalledWith(
        'test',
        'codex',
        'msg-turn-cancel',
        'codex',
      );
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('session cancelled'),
      );
    });

    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', { type: 'session.idle' });
      expect(res.status).toBe(400);
    });

    it('skips empty text chunks', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: '   ',
      });
      expect(res.status).toBe(200);
      // No message should be sent for whitespace-only text
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('uses Slack splitting for slack platform', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'slack' as const;
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create a message that's > 1900 chars (Discord limit) but < 3900 (Slack limit)
      const longText = 'x'.repeat(2500);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: longText,
      });
      expect(res.status).toBe(200);
      // With Slack splitting (3900 limit), the message should be sent as a single chunk
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('HTTP method filtering', () => {
    it('rejects non-POST requests', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/reload', method: 'GET' },
          (res) => resolve({ status: res.statusCode || 0 }),
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(405);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/unknown', {});
      expect(res.status).toBe(404);
    });
  });
});
