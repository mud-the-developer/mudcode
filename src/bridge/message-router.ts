import type { MessageContext, MessagingClient } from '../messaging/interface.js';
import { TmuxManager } from '../tmux/manager.js';
import type { IStateManager } from '../types/interfaces.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { downloadFileAttachments, buildFileMarkers } from '../infra/file-downloader.js';
import { PendingMessageTracker } from './pending-message-tracker.js';

export interface BridgeMessageRouterDeps {
  messaging: MessagingClient;
  tmux: TmuxManager;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  sanitizeInput: (content: string) => string | null;
}

type RouteResolutionSource = 'mapped' | 'reply' | 'conversation' | 'channel' | 'primary';

interface RouteMemory {
  projectName: string;
  instanceId: string;
  agentType: string;
}

interface SpecialKeyCommand {
  keyToken: string;
  repeat: number;
}

type SpecialKeyCommandParse =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; command: SpecialKeyCommand };

type SessionControlCommand = 'q' | 'qw';

export class BridgeMessageRouter {
  private routeByMessageId: Map<string, RouteMemory> = new Map();
  private routeByConversationKey: Map<string, RouteMemory> = new Map();
  private readonly maxMessageRoutes = 4000;
  private readonly maxConversationRoutes = 2000;

  constructor(private deps: BridgeMessageRouterDeps) {}

  private pruneOldest<K, V>(map: Map<K, V>, maxSize: number): void {
    while (map.size > maxSize) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  private rememberMessageRoute(messageId: string | undefined, route: RouteMemory): void {
    if (!messageId) return;
    this.routeByMessageId.set(messageId, route);
    this.pruneOldest(this.routeByMessageId, this.maxMessageRoutes);
  }

  private rememberConversationRoute(conversationKey: string | undefined, route: RouteMemory): void {
    if (!conversationKey) return;
    this.routeByConversationKey.set(conversationKey, route);
    this.pruneOldest(this.routeByConversationKey, this.maxConversationRoutes);
  }

  private resolveRememberedRoute(
    normalizedProject: ReturnType<typeof normalizeProjectState>,
    route: RouteMemory | undefined,
  ) {
    if (!route) return undefined;
    if (route.projectName !== normalizedProject.projectName) return undefined;
    return getProjectInstance(normalizedProject, route.instanceId);
  }

  private buildRouteMemory(projectName: string, instanceId: string, agentType: string): RouteMemory {
    return {
      projectName,
      instanceId,
      agentType,
    };
  }

  private routeHintFor(
    source: RouteResolutionSource,
    context?: MessageContext,
  ): 'reply' | 'thread' | 'memory' | undefined {
    if (source === 'reply') return 'reply';
    if (context?.threadId) return 'thread';
    if (source === 'conversation') return 'memory';
    return undefined;
  }

  private parseSpecialKeyCommand(content: string): SpecialKeyCommandParse {
    const trimmed = content.trim();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('!')) return { kind: 'none' };

    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { kind: 'none' };

    const commandToken = parts[0]!.toLowerCase();
    const shortcuts: Record<string, string> = {
      '/enter': 'enter',
      '/tab': 'tab',
      '/esc': 'esc',
      '/escape': 'escape',
      '/up': 'up',
      '/down': 'down',
    };
    const legacyBangCommands = new Set([
      '!enter',
      '!tab',
      '!esc',
      '!escape',
      '!up',
      '!down',
      '!key',
      '!keys',
    ]);

    let keyName: string | undefined;
    let repeatRaw: string | undefined;

    if (legacyBangCommands.has(commandToken)) {
      return {
        kind: 'invalid',
        message:
          '⚠️ `!` key commands were removed. Use slash commands: `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`',
      };
    }

    if (shortcuts[commandToken]) {
      keyName = shortcuts[commandToken];
      repeatRaw = parts[1];
      if (parts.length > 2) {
        return {
          kind: 'invalid',
          message: '⚠️ Too many arguments. Usage: `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`',
        };
      }
    } else {
      return { kind: 'none' };
    }

    const keyMap: Record<string, string> = {
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      esc: 'Escape',
      escape: 'Escape',
      up: 'Up',
      arrowup: 'Up',
      down: 'Down',
      arrowdown: 'Down',
    };
    const normalizedKeyName = keyName?.toLowerCase();
    const keyToken = normalizedKeyName ? keyMap[normalizedKeyName] : undefined;
    if (!keyToken) {
      return {
        kind: 'invalid',
        message: '⚠️ Unsupported key. Supported keys: `enter`, `tab`, `esc`, `up`, `down`',
      };
    }

    let repeat = 1;
    if (repeatRaw !== undefined) {
      if (!/^\d+$/.test(repeatRaw)) {
        return {
          kind: 'invalid',
          message: '⚠️ Count must be a number between 1 and 20.',
        };
      }
      repeat = parseInt(repeatRaw, 10);
      if (repeat < 1 || repeat > 20) {
        return {
          kind: 'invalid',
          message: '⚠️ Count must be between 1 and 20.',
        };
      }
    }

    return {
      kind: 'valid',
      command: {
        keyToken,
        repeat,
      },
    };
  }

  private parseSessionControlCommand(content: string): SessionControlCommand | undefined {
    const normalized = content.trim().toLowerCase();
    if (normalized === '/q') return 'q';
    if (normalized === '/qw') return 'qw';
    return undefined;
  }

  private isMissingTmuxTargetError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /can't find (window|pane)|no such (window|pane)|unknown target/i.test(message);
  }

  private forgetRoutesForInstance(projectName: string, instanceId: string): void {
    for (const [key, route] of this.routeByMessageId.entries()) {
      if (route.projectName === projectName && route.instanceId === instanceId) {
        this.routeByMessageId.delete(key);
      }
    }
    for (const [key, route] of this.routeByConversationKey.entries()) {
      if (route.projectName === projectName && route.instanceId === instanceId) {
        this.routeByConversationKey.delete(key);
      }
    }
  }

  private clearPendingForInstance(projectName: string, agentType: string, instanceId: string): void {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      clearPendingForInstance?: (projectName: string, agentType: string, instanceId?: string) => void;
    };
    pendingTracker.clearPendingForInstance?.(projectName, agentType, instanceId);
  }

  private async safePendingUpdate(action: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      console.warn(
        `Pending tracker update failed (${action}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private removeInstanceFromState(
    projectName: string,
    normalizedProject: ReturnType<typeof normalizeProjectState>,
    instanceId: string,
  ): void {
    const nextInstances = { ...(normalizedProject.instances || {}) };
    delete nextInstances[instanceId];

    if (Object.keys(nextInstances).length === 0) {
      this.deps.stateManager.removeProject(projectName);
      return;
    }

    this.deps.stateManager.setProject(
      normalizeProjectState({
        ...normalizedProject,
        instances: nextInstances,
        lastActive: new Date(),
      }),
    );
  }

  private async handleSessionControlCommand(params: {
    command: SessionControlCommand;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    channelId: string;
    messageId?: string;
    routeHint?: 'reply' | 'thread' | 'memory';
    agentType: string;
    instanceId: string;
    windowName: string;
  }): Promise<void> {
    let instanceRemoved = false;

    if (params.messageId) {
      await this.safePendingUpdate('session-control:markPending', () =>
        this.deps.pendingTracker.markPending(
          params.projectName,
          params.agentType,
          params.channelId,
          params.messageId!,
          params.instanceId,
        ),
      );
      await this.safePendingUpdate('session-control:markRouteResolved', () =>
        this.deps.pendingTracker.markRouteResolved(
          params.projectName,
          params.agentType,
          params.instanceId,
          params.routeHint,
        ),
      );
      await this.safePendingUpdate('session-control:markDispatching', () =>
        this.deps.pendingTracker.markDispatching(params.projectName, params.agentType, params.instanceId),
      );
    }

    try {
      try {
        this.deps.tmux.killWindow(params.normalizedProject.tmuxSession, params.windowName);
      } catch (error) {
        if (!this.isMissingTmuxTargetError(error)) {
          throw error;
        }
      }

      this.removeInstanceFromState(params.projectName, params.normalizedProject, params.instanceId);
      this.forgetRoutesForInstance(params.projectName, params.instanceId);
      instanceRemoved = true;

      if (params.command === 'q') {
        if (params.messageId) {
          await this.safePendingUpdate('session-control:markCompleted', () =>
            this.deps.pendingTracker.markCompleted(params.projectName, params.agentType, params.instanceId, 'tail'),
          );
        }
        const deleted = await this.deps.messaging.deleteChannel(params.channelId);
        if (!deleted) {
          await this.deps.messaging.sendToChannel(
            params.channelId,
            '⚠️ Closed tmux session, but failed to delete this channel.',
          );
        }
        return;
      }

      let archivedName: string | null = null;
      if (typeof this.deps.messaging.archiveChannel === 'function') {
        archivedName = await this.deps.messaging.archiveChannel(params.channelId);
      }

      if (params.messageId) {
        await this.safePendingUpdate('session-control:markCompleted', () =>
          this.deps.pendingTracker.markCompleted(params.projectName, params.agentType, params.instanceId, 'tail'),
        );
      }

      if (archivedName) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `✅ Closed tmux session. Saved this channel as \`${archivedName}\`.`,
        );
      } else if (typeof this.deps.messaging.archiveChannel === 'function') {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Closed tmux session, but failed to rename this channel.',
        );
      } else {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Closed tmux session. Channel-save rename is not supported on this platform.',
        );
      }
    } catch (error) {
      if (params.messageId) {
        await this.safePendingUpdate('session-control:markError', () =>
          this.deps.pendingTracker.markError(params.projectName, params.agentType, params.instanceId, 'tail'),
        );
      }
      await this.deps.messaging.sendToChannel(
        params.channelId,
        this.buildDeliveryFailureGuidance(params.projectName, error),
      );
    } finally {
      if (instanceRemoved) {
        this.clearPendingForInstance(params.projectName, params.agentType, params.instanceId);
      }
      this.deps.stateManager.updateLastActive(params.projectName);
    }
  }

  private submitSpecialKeyCommand(
    tmuxSession: string,
    windowName: string,
    paneHint: string,
    command: SpecialKeyCommand,
  ): void {
    for (let i = 0; i < command.repeat; i += 1) {
      this.deps.tmux.sendRawKeyToWindow(tmuxSession, windowName, command.keyToken, paneHint);
    }
  }

  register(): void {
    const { messaging } = this.deps;

    messaging.onMessage(async (agentType, content, projectName, channelId, messageId, mappedInstanceId, attachments, context) => {
      console.log(
        `📨 [${projectName}/${agentType}${mappedInstanceId ? `#${mappedInstanceId}` : ''}] ${content.substring(0, 50)}...`,
      );

      const project = this.deps.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await messaging.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      const normalizedProject = normalizeProjectState(project);
      const routeChannelId = context?.routeChannelId || channelId;
      const fromMappedId = mappedInstanceId ? getProjectInstance(normalizedProject, mappedInstanceId) : undefined;
      const fromReply = this.resolveRememberedRoute(
        normalizedProject,
        context?.replyToMessageId ? this.routeByMessageId.get(context.replyToMessageId) : undefined,
      );
      const fromConversation = this.resolveRememberedRoute(
        normalizedProject,
        context?.conversationKey ? this.routeByConversationKey.get(context.conversationKey) : undefined,
      );
      const fromChannel = findProjectInstanceByChannel(normalizedProject, routeChannelId);
      const fromPrimary = getPrimaryInstanceForAgent(normalizedProject, agentType);

      const mappedInstance = fromMappedId || fromReply || fromConversation || fromChannel || fromPrimary;
      const routeSource: RouteResolutionSource = fromMappedId
        ? 'mapped'
        : fromReply
          ? 'reply'
          : fromConversation
            ? 'conversation'
            : fromChannel
              ? 'channel'
              : 'primary';

      if (!mappedInstance) {
        await messaging.sendToChannel(channelId, '⚠️ Agent instance mapping not found for this channel');
        return;
      }

      const resolvedAgentType = mappedInstance.agentType;
      const instanceKey = mappedInstance.instanceId;
      const windowName = mappedInstance.tmuxWindow || instanceKey;
      const routeMemory = this.buildRouteMemory(projectName, instanceKey, resolvedAgentType);
      const commandChannelId = mappedInstance.channelId || routeChannelId || channelId;

      const sessionControlCommand = this.parseSessionControlCommand(content);
      if (sessionControlCommand) {
        await this.handleSessionControlCommand({
          command: sessionControlCommand,
          projectName,
          normalizedProject,
          channelId: commandChannelId,
          messageId,
          routeHint: this.routeHintFor(routeSource, context),
          agentType: resolvedAgentType,
          instanceId: instanceKey,
          windowName,
        });
        return;
      }

      let promptToSend: string | null = null;
      let specialKeyCommand: SpecialKeyCommand | null = null;
      let downloadedAttachmentCount = 0;
      const keyCommand = this.parseSpecialKeyCommand(content);
      if (keyCommand.kind === 'invalid') {
        await messaging.sendToChannel(channelId, keyCommand.message);
        return;
      }

      if (keyCommand.kind === 'valid') {
        specialKeyCommand = keyCommand.command;
      } else {
        let enrichedContent = content;
        if (attachments && attachments.length > 0) {
          try {
            const downloaded = await downloadFileAttachments(attachments, project.projectPath, attachments[0]?.authHeaders);
            if (downloaded.length > 0) {
              const markers = buildFileMarkers(downloaded);
              enrichedContent = content + markers;
              downloadedAttachmentCount = downloaded.length;
              console.log(`📎 [${projectName}/${agentType}] ${downloaded.length} file(s) attached`);
            }
          } catch (error) {
            console.warn('Failed to process file attachments:', error);
          }
        }

        const sanitized = this.deps.sanitizeInput(enrichedContent);
        if (!sanitized) {
          await messaging.sendToChannel(channelId, '⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters');
          return;
        }
        promptToSend = sanitized;
      }

      if (messageId) {
        await this.safePendingUpdate('message:markPending', () =>
          this.deps.pendingTracker.markPending(
            projectName,
            resolvedAgentType,
            channelId,
            messageId,
            instanceKey,
            promptToSend || undefined,
          ),
        );
        await this.safePendingUpdate('message:markRouteResolved', () =>
          this.deps.pendingTracker.markRouteResolved(
            projectName,
            resolvedAgentType,
            instanceKey,
            this.routeHintFor(routeSource, context),
          ),
        );
        if (downloadedAttachmentCount > 0) {
          await this.safePendingUpdate('message:markHasAttachments', () =>
            this.deps.pendingTracker.markHasAttachments(projectName, resolvedAgentType, instanceKey),
          );
        }
        await this.safePendingUpdate('message:markDispatching', () =>
          this.deps.pendingTracker.markDispatching(projectName, resolvedAgentType, instanceKey),
        );
      }

      let delivered = false;
      try {
        if (specialKeyCommand) {
          this.submitSpecialKeyCommand(normalizedProject.tmuxSession, windowName, resolvedAgentType, specialKeyCommand);
          delivered = true;
          await this.safePendingUpdate('message:markCompleted', () =>
            this.deps.pendingTracker.markCompleted(projectName, resolvedAgentType, instanceKey, 'tail'),
          );
        } else if (resolvedAgentType === 'opencode') {
          await this.submitToOpencode(normalizedProject.tmuxSession, windowName, promptToSend || '');
          delivered = true;
        } else if (resolvedAgentType === 'codex') {
          const codexResult = await this.submitToCodex(normalizedProject.tmuxSession, windowName, promptToSend || '');
          if (codexResult === 'restarted') {
            await this.safePendingUpdate('message:markRetry', () =>
              this.deps.pendingTracker.markRetry(projectName, resolvedAgentType, instanceKey, 'tail'),
            );
            await messaging.sendToChannel(
              channelId,
              '⚠️ Codex pane was not active, so I relaunched `codex` in tmux. Send your message again in a few seconds.',
            );
            return;
          }
          delivered = true;
        } else {
          this.deps.tmux.sendKeysToWindow(normalizedProject.tmuxSession, windowName, promptToSend || '', resolvedAgentType);
          delivered = true;
        }
      } catch (error) {
        await this.safePendingUpdate('message:markError', () =>
          this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey, 'tail'),
        );
        await messaging.sendToChannel(channelId, this.buildDeliveryFailureGuidance(projectName, error));
      }

      if (delivered) {
        this.rememberMessageRoute(messageId, routeMemory);
        this.rememberConversationRoute(context?.conversationKey, routeMemory);
      }
      this.deps.stateManager.updateLastActive(projectName);
    });
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.trunc(n);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async submitToOpencode(tmuxSession: string, windowName: string, prompt: string): Promise<void> {
    this.deps.tmux.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), 'opencode');
    const delayMs = this.getEnvInt('AGENT_DISCORD_OPENCODE_SUBMIT_DELAY_MS', 75);
    await this.sleep(delayMs);
    this.deps.tmux.sendEnterToWindow(tmuxSession, windowName, 'opencode');
  }

  private isShellForegroundCommand(command: string): boolean {
    const normalized = command.trim().toLowerCase().replace(/\.exe$/, '');
    return new Set([
      'bash',
      'zsh',
      'sh',
      'fish',
      'dash',
      'ksh',
      'tcsh',
      'csh',
      'cmd',
      'powershell',
      'pwsh',
      'nu',
    ]).has(normalized);
  }

  private async submitToCodex(tmuxSession: string, windowName: string, prompt: string): Promise<'sent' | 'restarted'> {
    const foregroundCommand = this.deps.tmux.getPaneCurrentCommand(tmuxSession, windowName, 'codex');
    if (this.isShellForegroundCommand(foregroundCommand)) {
      this.deps.tmux.typeKeysToWindow(tmuxSession, windowName, 'codex', 'codex');
      this.deps.tmux.sendEnterToWindow(tmuxSession, windowName, 'codex');
      return 'restarted';
    }

    this.deps.tmux.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), 'codex');
    const delayMs = this.getEnvInt('AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS', 75);
    await this.sleep(delayMs);
    this.deps.tmux.sendEnterToWindow(tmuxSession, windowName, 'codex');
    return 'sent';
  }

  private buildDeliveryFailureGuidance(projectName: string, error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const missingTarget = /can't find (window|pane)/i.test(rawMessage);

    if (missingTarget) {
      return (
        `⚠️ I couldn't deliver your message because the agent tmux window is not running.\n` +
        `Please restart the agent session, then send your message again:\n` +
        `1) \`mudcode new --name ${projectName}\`\n` +
        `2) \`mudcode attach ${projectName}\``
      );
    }

    return (
      `⚠️ I couldn't deliver your message to the tmux agent session.\n` +
      `Please confirm the agent is running, then try again.\n` +
      `If needed, restart with \`mudcode new --name ${projectName}\`.`
    );
  }
}
