import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

function createMockMessaging(platform: 'discord' | 'slack' = 'slack') {
  return {
    platform,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
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
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
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
