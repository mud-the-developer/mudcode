/**
 * Main entry point for mudcode
 */

import { DiscordClient } from './discord/client.js';
import { SlackClient } from './slack/client.js';
import type { MessagingClient } from './messaging/interface.js';
import { TmuxManager } from './tmux/manager.js';
import { createTmuxManager } from './tmux/factory.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import type { ProjectAgents, ProjectInstanceState } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';
import {
  buildNextInstanceId,
  getProjectInstance,
  normalizeProjectState,
} from './state/instances.js';
import { installFileInstruction } from './infra/file-instruction.js';
import { installMudcodeSendScript } from './infra/send-script.js';
import { buildAgentLaunchEnv, buildExportPrefix, withClaudePluginDir } from './policy/agent-launch.js';
import { installAgentIntegration } from './policy/agent-integration.js';
import { toProjectScopedName, toProjectScopedChannelName } from './policy/window-naming.js';
import { PendingMessageTracker } from './bridge/runtime/pending-message-tracker.js';
import { BridgeProjectBootstrap } from './bridge/bootstrap/project-bootstrap.js';
import { BridgeMessageRouter } from './bridge/runtime/message-router.js';
import { BridgeHookServer } from './bridge/runtime/hook-server.js';
import { BridgeCapturePoller } from './bridge/runtime/capture-poller.js';
import { TurnRouteLedger } from './bridge/runtime/turn-route-ledger.js';
import { LocalAgentEventHookClient } from './bridge/events/agent-event-hook.js';
import { CodexIoV2Tracker } from './bridge/events/codex-io-v2.js';
import { SkillAutoLinker } from './bridge/skills/skill-autolinker.js';
import { PromptRefiner } from './prompt/refiner.js';

export interface AgentBridgeDeps {
  messaging?: MessagingClient;
  tmux?: TmuxManager;
  stateManager?: IStateManager;
  registry?: AgentRegistry;
  config?: BridgeConfig;
}

export class AgentBridge {
  private messaging: MessagingClient;
  private tmux: TmuxManager;
  private pendingTracker: PendingMessageTracker;
  private projectBootstrap: BridgeProjectBootstrap;
  private messageRouter: BridgeMessageRouter;
  private hookServer: BridgeHookServer;
  private capturePoller: BridgeCapturePoller;
  private turnRouteLedger: TurnRouteLedger;
  private eventHookClient: LocalAgentEventHookClient;
  private codexIoTracker: CodexIoV2Tracker;
  private skillAutoLinker: SkillAutoLinker;
  private promptRefiner: PromptRefiner;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.messaging = deps?.messaging || this.createMessagingClient();
    this.tmux =
      deps?.tmux ||
      createTmuxManager(this.bridgeConfig);
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.promptRefiner = new PromptRefiner(this.bridgeConfig.promptRefiner);
    this.codexIoTracker = new CodexIoV2Tracker({
      messaging: this.messaging,
    });
    this.eventHookClient = new LocalAgentEventHookClient({
      port: this.bridgeConfig.hookServerPort || 18470,
    });
    this.skillAutoLinker = new SkillAutoLinker();
    this.pendingTracker = new PendingMessageTracker(this.messaging);
    this.turnRouteLedger = new TurnRouteLedger();
    this.projectBootstrap = new BridgeProjectBootstrap(this.stateManager, this.messaging, this.bridgeConfig.hookServerPort || 18470);
    this.messageRouter = new BridgeMessageRouter({
      messaging: this.messaging,
      tmux: this.tmux,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      turnRouteLedger: this.turnRouteLedger,
      reloadChannelMappings: () => this.projectBootstrap.reloadChannelMappings(),
      sanitizeInput: (content) => this.sanitizeInput(content),
      ioTracker: this.codexIoTracker,
      skillAutoLinker: this.skillAutoLinker,
      eventHookClient: this.eventHookClient,
      orchestratorWorkerProvisioner: {
        spawnCodexWorkers: (params) => this.spawnOrchestratorCodexWorkers(params),
        teardownWorker: (params) => this.teardownOrchestratorWorker(params),
      },
    });
    this.hookServer = new BridgeHookServer({
      port: this.bridgeConfig.hookServerPort || 18470,
      messaging: this.messaging,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      turnRouteLedger: this.turnRouteLedger,
      reloadChannelMappings: () => this.projectBootstrap.reloadChannelMappings(),
    });
    this.capturePoller = new BridgeCapturePoller({
      messaging: this.messaging,
      tmux: this.tmux,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      intervalMs: this.bridgeConfig.capture?.pollMs,
      quietPendingPollThreshold: this.bridgeConfig.capture?.pendingQuietPolls,
      codexInitialQuietPendingPollThreshold: this.bridgeConfig.capture?.pendingInitialQuietPollsCodex,
      codexFinalOnlyModeEnabled: this.bridgeConfig.capture?.codexFinalOnly,
      longOutputThreadThreshold: this.bridgeConfig.capture?.longOutputThreadThreshold,
      stalePendingAlertMs: this.bridgeConfig.capture?.staleAlertMs,
      promptEchoFilterEnabled: this.bridgeConfig.capture?.filterPromptEcho,
      promptEchoSuppressionMaxPolls: this.bridgeConfig.capture?.promptEchoMaxPolls,
      redrawFallbackTailLines: this.bridgeConfig.capture?.redrawTailLines,
      finalOnlyBufferMaxChars: this.bridgeConfig.capture?.finalBufferMaxChars,
      progressOutputVisibility: this.bridgeConfig.capture?.progressOutput,
      ioTracker: this.codexIoTracker,
      eventHookClient: this.eventHookClient,
      eventLifecycleStaleChecker: (projectName, instanceId) =>
        this.hookServer.isEventLifecycleMissingOrStale(projectName, instanceId),
    });
  }

  private createMessagingClient(): MessagingClient {
    if (this.bridgeConfig.messagingPlatform === 'slack') {
      if (!this.bridgeConfig.slack) {
        throw new Error('Slack is configured as messaging platform but Slack tokens are missing. Run: mudcode onboard --platform slack');
      }
      return new SlackClient(this.bridgeConfig.slack.botToken, this.bridgeConfig.slack.appToken);
    }
    return new DiscordClient(this.bridgeConfig.discord.token);
  }

  /**
   * Sanitize message input before passing to tmux
   */
  public sanitizeInput(content: string): string | null {
    // Reject empty/whitespace-only messages
    if (!content || content.trim().length === 0) {
      return null;
    }

    // Limit message length to prevent abuse
    if (content.length > 10000) {
      return null;
    }

    // Strip null bytes
    const sanitized = content.replace(/\0/g, '');
    return this.promptRefiner.process(sanitized).output;
  }

  /**
   * Connect messaging client (for init command)
   */
  async connect(): Promise<void> {
    await this.messaging.connect();
  }

  private resolveBridgePort(): number {
    return this.bridgeConfig.hookServerPort || 18470;
  }

  private ensureProjectSessionExists(
    project: ReturnType<typeof normalizeProjectState>,
    firstWindowName?: string,
  ): string {
    const fullSessionName = project.tmuxSession;
    if (this.tmux.sessionExistsFull(fullSessionName)) {
      return fullSessionName;
    }

    const prefix = this.bridgeConfig.tmux.sessionPrefix || '';
    if (prefix && fullSessionName.startsWith(prefix)) {
      const baseSession = fullSessionName.slice(prefix.length) || project.projectName;
      return this.tmux.getOrCreateSession(baseSession, firstWindowName);
    }

    return this.tmux.getOrCreateSession(project.projectName, firstWindowName);
  }

  private async spawnOrchestratorCodexWorkers(params: {
    projectName: string;
    count: number;
  }): Promise<{
    created: ProjectInstanceState[];
    warnings?: string[];
  }> {
    const project = this.stateManager.getProject(params.projectName);
    if (!project) {
      return {
        created: [],
        warnings: [`project \`${params.projectName}\` not found`],
      };
    }
    const adapter = this.registry.get('codex');
    if (!adapter) {
      return {
        created: [],
        warnings: ['codex adapter not found'],
      };
    }

    const warnings: string[] = [];
    const created: ProjectInstanceState[] = [];
    const port = this.resolveBridgePort();
    const targetCount = Math.min(15, Math.max(1, Math.trunc(params.count || 1)));
    let normalizedProject = normalizeProjectState(project);

    try {
      installFileInstruction(normalizedProject.projectPath, 'codex');
    } catch (error) {
      warnings.push(`file instructions: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      installMudcodeSendScript(normalizedProject.projectPath, {
        projectName: normalizedProject.projectName,
        port,
      });
    } catch {
      // Non-critical.
    }

    for (let i = 0; i < targetCount; i += 1) {
      const instanceId = buildNextInstanceId(normalizedProject, 'codex');
      const windowName = toProjectScopedName(normalizedProject.projectName, 'codex', instanceId);
      try {
        const tmuxSession = this.ensureProjectSessionExists(normalizedProject, windowName);
        this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));

        const exportPrefix = buildExportPrefix(buildAgentLaunchEnv({
          projectName: normalizedProject.projectName,
          port,
          agentType: 'codex',
          instanceId,
          permissionAllow: false,
        }));
        const startCommand = adapter.getStartCommand(normalizedProject.projectPath, false);
        this.tmux.startAgentInWindow(tmuxSession, windowName, `${exportPrefix}${startCommand}`);

        const createdInstance: ProjectInstanceState = {
          instanceId,
          agentType: 'codex',
          tmuxWindow: windowName,
          eventHook: false,
        };
        normalizedProject = normalizeProjectState({
          ...normalizedProject,
          instances: {
            ...(normalizedProject.instances || {}),
            [instanceId]: createdInstance,
          },
          lastActive: new Date(),
        });
        this.stateManager.setProject(normalizedProject);
        created.push(createdInstance);
      } catch (error) {
        warnings.push(`${instanceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      created,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async teardownOrchestratorWorker(params: {
    projectName: string;
    workerInstanceId: string;
  }): Promise<{
    removed: boolean;
    removedInstance?: ProjectInstanceState;
    warning?: string;
  }> {
    const project = this.stateManager.getProject(params.projectName);
    if (!project) {
      return {
        removed: false,
        warning: `project \`${params.projectName}\` not found`,
      };
    }
    const normalizedProject = normalizeProjectState(project);
    const worker = getProjectInstance(normalizedProject, params.workerInstanceId);
    if (!worker) {
      return {
        removed: false,
        warning: `worker \`${params.workerInstanceId}\` not found`,
      };
    }

    const nextInstances = {
      ...(normalizedProject.instances || {}),
    };
    delete nextInstances[params.workerInstanceId];
    if (Object.keys(nextInstances).length === 0) {
      return {
        removed: false,
        warning: 'cannot remove the last remaining instance',
      };
    }

    let warning: string | undefined;
    const windowName = worker.tmuxWindow || worker.instanceId;
    try {
      if (this.tmux.windowExists(normalizedProject.tmuxSession, windowName)) {
        this.tmux.killWindow(normalizedProject.tmuxSession, windowName);
      }
    } catch (error) {
      warning = `tmux cleanup warning: ${error instanceof Error ? error.message : String(error)}`;
    }

    const nextProject = normalizeProjectState({
      ...normalizedProject,
      instances: nextInstances,
      lastActive: new Date(),
    });
    this.stateManager.setProject(nextProject);

    return {
      removed: true,
      removedInstance: worker,
      ...(warning ? { warning } : {}),
    };
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Mudcode...');

    await this.messaging.connect();
    console.log('✅ Messaging client connected');

    this.projectBootstrap.bootstrapProjects();
    this.messageRouter.register();
    this.hookServer.start();
    this.capturePoller.start();

    console.log('✅ Mudcode is running');
    console.log(`📡 Server listening on port ${this.bridgeConfig.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${this.registry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string,
    overridePort?: number,
    options?: { instanceId?: string },
  ): Promise<{ channelName: string; channelId: string; agentName: string; tmuxSession: string }> {
    const isSlack = this.bridgeConfig.messagingPlatform === 'slack';
    const guildId = isSlack ? this.stateManager.getWorkspaceId() : this.stateManager.getGuildId();
    if (!guildId) {
      throw new Error('Server ID not configured. Run: mudcode config --server <id>');
    }

    // Collect enabled agents (should be only one)
    const enabledAgents = this.registry.getAll().filter(a => agents[a.config.name]);
    const adapter = enabledAgents[0];

    if (!adapter) {
      throw new Error('No agent specified');
    }

    const existingProject = this.stateManager.getProject(projectName);
    const normalizedExisting = existingProject ? normalizeProjectState(existingProject) : undefined;

    const requestedInstanceId = options?.instanceId?.trim();
    const instanceId = requestedInstanceId || buildNextInstanceId(normalizedExisting, adapter.config.name);
    if (normalizedExisting && getProjectInstance(normalizedExisting, instanceId)) {
      throw new Error(`Instance already exists: ${instanceId}`);
    }

    // Create tmux session (shared mode)
    const sharedSessionName = this.bridgeConfig.tmux.sharedSessionName || 'bridge';
    const windowName = toProjectScopedName(projectName, adapter.config.name, instanceId);
    const tmuxSession = this.tmux.getOrCreateSession(sharedSessionName, windowName);

    // Create Discord channel with custom name or default
    const channelName = channelDisplayName || toProjectScopedChannelName(projectName, adapter.config.channelSuffix, instanceId);
    const channels = await this.messaging.createAgentChannels(
      guildId,
      projectName,
      [adapter.config],
      channelName,
      { [adapter.config.name]: instanceId },
    );

    const channelId = channels[adapter.config.name];

    const port = overridePort || this.bridgeConfig.hookServerPort || 18470;
    // Avoid setting AGENT_DISCORD_PROJECT on shared session env (ambiguous across windows).
    this.tmux.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));

    // Start agent in tmux window
    const permissionAllow = this.bridgeConfig.opencode?.permissionMode === 'allow';
    const integration =
      adapter.config.name === 'codex'
        ? undefined
        : installAgentIntegration(adapter.config.name, projectPath, 'install');
    for (const message of integration?.infoMessages ?? []) {
      console.log(message);
    }
    for (const message of integration?.warningMessages ?? []) {
      console.warn(message);
    }

    // Install file-handling instructions and mudcode-send script for the agent
    try {
      installFileInstruction(projectPath, adapter.config.name);
      console.log(`📎 Installed file instructions for ${adapter.config.displayName}`);
    } catch (error) {
      console.warn(`Failed to install file instructions: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      installMudcodeSendScript(projectPath, { projectName, port });
    } catch {
      // Non-critical.
    }

    const exportPrefix = buildExportPrefix(buildAgentLaunchEnv({
      projectName,
      port,
      agentType: adapter.config.name,
      instanceId,
      permissionAllow: adapter.config.name === 'opencode' && permissionAllow,
    }));
    const startCommand = withClaudePluginDir(
      adapter.getStartCommand(projectPath, permissionAllow),
      integration?.claudePluginDir,
    );

    this.tmux.startAgentInWindow(
      tmuxSession,
      windowName,
      `${exportPrefix}${startCommand}`
    );

    // Save state
    const baseProject = normalizedExisting || {
      projectName,
      projectPath,
      tmuxSession,
      createdAt: new Date(),
      lastActive: new Date(),
      agents: {},
      discordChannels: {},
      instances: {},
    };
    const nextInstances = {
      ...(baseProject.instances || {}),
      [instanceId]: {
        instanceId,
        agentType: adapter.config.name,
        tmuxWindow: windowName,
        channelId,
        eventHook:
          adapter.config.name === 'opencode' || integration?.eventHookInstalled === true,
      },
    };
    const projectState = normalizeProjectState({
      ...baseProject,
      projectName,
      projectPath,
      tmuxSession,
      instances: nextInstances,
      lastActive: new Date(),
    });
    this.stateManager.setProject(projectState);

    return {
      channelName,
      channelId,
      agentName: adapter.config.displayName,
      tmuxSession,
    };
  }

  async stop(): Promise<void> {
    this.hookServer.stop();
    this.capturePoller.stop();
    await this.messaging.disconnect();
  }
}

export async function main() {
  const bridge = new AgentBridge();

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    try {
      await bridge.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
    process.exit(0);
  });

  await bridge.start();
}
