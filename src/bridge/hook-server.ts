import { createServer } from 'http';
import { parse } from 'url';
import { existsSync, realpathSync } from 'fs';
import { basename, resolve } from 'path';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker, type PendingRuntimeSnapshot } from './pending-message-tracker.js';
import { formatDiscordOutput, wrapDiscordCodeblock } from './discord-output-formatter.js';

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  reloadChannelMappings: () => void;
}

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;
  private ignoredEventsByInstance = new Map<
    string,
    { count: number; byType: Record<string, number>; lastIgnoredAtMs: number }
  >();

  constructor(private deps: BridgeHookServerDeps) {}

  private runtimeKey(projectName: string, instanceId: string): string {
    return `${projectName}:${instanceId}`;
  }

  private markIgnoredEvent(
    projectName: string,
    instanceId: string,
    eventType?: string,
  ): void {
    const key = this.runtimeKey(projectName, instanceId);
    const current = this.ignoredEventsByInstance.get(key) || {
      count: 0,
      byType: {},
      lastIgnoredAtMs: Date.now(),
    };
    current.count += 1;
    const typeKey = typeof eventType === 'string' && eventType.trim().length > 0 ? eventType.trim() : 'unknown';
    current.byType[typeKey] = (current.byType[typeKey] || 0) + 1;
    current.lastIgnoredAtMs = Date.now();
    this.ignoredEventsByInstance.set(key, current);
  }

  private getIgnoredEventSnapshot(
    projectName: string,
    instanceId: string,
  ): { ignoredEventCount: number; ignoredEventTypes: Record<string, number>; ignoredLastAt: string } | undefined {
    const key = this.runtimeKey(projectName, instanceId);
    const snapshot = this.ignoredEventsByInstance.get(key);
    if (!snapshot || snapshot.count <= 0) return undefined;
    return {
      ignoredEventCount: snapshot.count,
      ignoredEventTypes: { ...snapshot.byType },
      ignoredLastAt: new Date(snapshot.lastIgnoredAtMs).toISOString(),
    };
  }

  private resolveOutputRoute(
    defaultChannelId: string | undefined,
    projectName: string,
    agentType: string,
    instanceId?: string,
  ): { channelId: string | undefined; pendingDepth: number } {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getPendingChannel?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
    };
    const pendingChannel =
      typeof pendingTracker.getPendingChannel === 'function'
        ? pendingTracker.getPendingChannel(projectName, agentType, instanceId)
        : undefined;
    const pendingDepth =
      typeof pendingTracker.getPendingDepth === 'function'
        ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
        : pendingChannel
          ? 1
          : 0;

    if (pendingDepth > 1) {
      return { channelId: defaultChannelId || pendingChannel, pendingDepth };
    }

    return { channelId: pendingChannel || defaultChannelId, pendingDepth };
  }

  private resolveLongOutputThreadThreshold(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1200) {
      return Math.trunc(fromEnv);
    }
    return 2000;
  }

  private shouldUseThreadedLongOutput(text: string): boolean {
    return (
      this.deps.messaging.platform === 'discord' &&
      text.length >= this.resolveLongOutputThreadThreshold() &&
      typeof this.deps.messaging.sendLongOutput === 'function'
    );
  }

  private async sendEventOutput(channelId: string, text: string): Promise<void> {
    const discordFormatted =
      this.deps.messaging.platform === 'discord'
        ? formatDiscordOutput(text)
        : { text, useCodeblock: false, language: 'text' };
    const content = discordFormatted.text;
    if (content.trim().length === 0) return;

    if (this.shouldUseThreadedLongOutput(content)) {
      await this.deps.messaging.sendLongOutput!(channelId, content);
      return;
    }

    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    for (const chunk of split(content)) {
      if (chunk.trim().length === 0) continue;
      const payload =
        this.deps.messaging.platform === 'discord' && discordFormatted.useCodeblock
          ? wrapDiscordCodeblock(chunk, discordFormatted.language)
          : chunk;
      await this.deps.messaging.sendToChannel(channelId, payload);
    }
  }

  private buildFileNotice(filePaths: string[]): string {
    const names = filePaths.map((path) => basename(path));
    if (names.length === 0) return '📎 Generated files attached.';
    if (names.length <= 3) {
      return `📎 Generated file${names.length > 1 ? 's' : ''}: ${names.map((n) => `\`${n}\``).join(', ')}`;
    }
    const head = names.slice(0, 3).map((n) => `\`${n}\``).join(', ');
    return `📎 Generated ${names.length} files: ${head}, …`;
  }

  private getRuntimeSnapshotForInstance(
    projectName: string,
    agentType: string,
    instanceId?: string,
  ): PendingRuntimeSnapshot {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getRuntimeSnapshot?: (projectName: string, agentType: string, instanceId?: string) => PendingRuntimeSnapshot;
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
    };
    if (typeof pendingTracker.getRuntimeSnapshot === 'function') {
      return pendingTracker.getRuntimeSnapshot(projectName, agentType, instanceId);
    }
    const pendingDepth =
      typeof pendingTracker.getPendingDepth === 'function'
        ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
        : 0;
    return { pendingDepth };
  }

  private buildRuntimeStatusPayload(): {
    generatedAt: string;
    instances: Array<{
      projectName: string;
      instanceId: string;
      agentType: string;
      ignoredEventCount?: number;
      ignoredEventTypes?: Record<string, number>;
      ignoredLastAt?: string;
    } & PendingRuntimeSnapshot>;
  } {
    const projects = this.deps.stateManager.listProjects().map((project) => normalizeProjectState(project));
    const instances: Array<{
      projectName: string;
      instanceId: string;
      agentType: string;
    } & PendingRuntimeSnapshot> = [];

    for (const project of projects) {
      for (const instance of listProjectInstances(project)) {
        const ignored = this.getIgnoredEventSnapshot(project.projectName, instance.instanceId);
        instances.push({
          projectName: project.projectName,
          instanceId: instance.instanceId,
          agentType: instance.agentType,
          ...this.getRuntimeSnapshotForInstance(project.projectName, instance.agentType, instance.instanceId),
          ...(ignored || {}),
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      instances,
    };
  }

  start(): void {
    this.httpServer = createServer(async (req, res) => {
      const { pathname } = parse(req.url || '');

      if (req.method === 'GET' && pathname === '/runtime-status') {
        const payload = this.buildRuntimeStatusPayload();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        void (async () => {
          try {
            if (pathname === '/reload') {
              this.deps.reloadChannelMappings();
              res.writeHead(200);
              res.end('OK');
              return;
            }

            if (pathname === '/send-files') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const result = await this.handleSendFiles(payload);
              res.writeHead(result.status);
              res.end(result.message);
              return;
            }

            if (pathname === '/opencode-event') {
              let payload: unknown;
              try {
                payload = body ? JSON.parse(body) : {};
              } catch {
                res.writeHead(400);
                res.end('Invalid JSON');
                return;
              }

              const ok = await this.handleOpencodeEvent(payload);
              if (ok) {
                res.writeHead(200);
                res.end('OK');
              } else {
                res.writeHead(400);
                res.end('Invalid event payload');
              }
              return;
            }

            res.writeHead(404);
            res.end('Not found');
          } catch (error) {
            console.error('Request processing error:', error);
            res.writeHead(500);
            res.end('Internal error');
          }
        })();
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(this.deps.port, '127.0.0.1');
  }

  stop(): void {
    this.httpServer?.close();
    this.httpServer = undefined;
  }

  /**
   * Validate an array of file paths: each must exist and reside within the project directory.
   */
  private validateFilePaths(paths: string[], projectPath: string): string[] {
    if (!projectPath) return [];
    return paths.filter((p) => {
      if (!existsSync(p)) return false;
      try {
        const real = realpathSync(p);
        return real.startsWith(projectPath + '/') || real === projectPath;
      } catch {
        return false;
      }
    });
  }

  private async handleSendFiles(payload: unknown): Promise<{ status: number; message: string }> {
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const files = Array.isArray(event.files) ? (event.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];

    if (!projectName) return { status: 400, message: 'Missing projectName' };
    if (files.length === 0) return { status: 400, message: 'No files provided' };

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return { status: 404, message: 'Project not found' };

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    const routeInfo = this.resolveOutputRoute(
      instance?.channelId,
      projectName,
      resolvedAgentType,
      resolvedInstanceId,
    );
    const channelId = routeInfo.channelId;
    if (!channelId) return { status: 404, message: 'No channel found for project/agent' };

    const projectPath = project.projectPath ? resolve(project.projectPath) : '';
    const validFiles = this.validateFilePaths(files, projectPath);
    if (validFiles.length === 0) return { status: 400, message: 'No valid files' };

    console.log(
      `📤 [${projectName}/${instance?.agentType || agentType}] send-files: ${validFiles.length} file(s)`,
    );

    await this.deps.messaging.sendToChannelWithFiles(channelId, this.buildFileNotice(validFiles), validFiles);
    return { status: 200, message: 'OK' };
  }

  private getEventText(payload: Record<string, unknown>): string | undefined {
    const direct = payload.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;

    const message = payload.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    return undefined;
  }

  private async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    if (!payload || typeof payload !== 'object') return false;

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    if (!projectName) return false;

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return false;

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    if (instance?.eventHook === false) {
      this.markIgnoredEvent(projectName, instance.instanceId, eventType);
      console.log(
        `⏭️ [${projectName}/${resolvedAgentType}${instance ? `#${instance.instanceId}` : ''}] ignoring ${eventType || 'unknown'} event (eventHook disabled)`,
      );
      return true;
    }
    const routeInfo = this.resolveOutputRoute(
      instance?.channelId,
      projectName,
      resolvedAgentType,
      resolvedInstanceId,
    );
    const channelId = routeInfo.channelId;
    if (!channelId) return false;

    const text = this.getEventText(event);
    console.log(
      `🔍 [${projectName}/${instance?.agentType || agentType}${instance ? `#${instance.instanceId}` : ''}] event=${eventType} text=${text ? `(${text.length} chars) ${text.substring(0, 100)}` : '(empty)'}`,
    );

    if (eventType === 'session.error') {
      // Fire reaction update in background – don't block message delivery
      this.deps.pendingTracker.markError(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
      const msg = text || 'unknown error';
      await this.deps.messaging.sendToChannel(channelId, `⚠️ OpenCode session error: ${msg}`);
      return true;
    }

    if (eventType === 'session.idle') {
      try {
        if (text && text.trim().length > 0) {
          const trimmed = text.trim();
          // Use turnText (all assistant text from the turn) for file path extraction
          // to handle the race condition where displayText doesn't contain file paths
          const turnText = typeof event.turnText === 'string' ? event.turnText.trim() : '';
          const fileSearchText = turnText || trimmed;
          const projectPath = project.projectPath ? resolve(project.projectPath) : '';
          const filePaths = this.validateFilePaths(extractFilePaths(fileSearchText), projectPath);

          // Strip file paths from the display text to avoid leaking absolute paths
          const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;

          await this.sendEventOutput(channelId, displayText);

          if (filePaths.length > 0) {
            await this.deps.messaging.sendToChannelWithFiles(channelId, this.buildFileNotice(filePaths), filePaths);
          }
        }

        // Complete after idle output delivery so pending-channel routing remains stable.
        await this.deps.pendingTracker.markCompleted(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
        return true;
      } catch (error) {
        await this.deps.pendingTracker.markError(projectName, resolvedAgentType, resolvedInstanceId).catch(() => {});
        throw error;
      }
    }

    return true;
  }
}
