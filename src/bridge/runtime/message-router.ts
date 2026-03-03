import type { MessageContext, MessagingClient } from '../../messaging/interface.js';
import { TmuxManager } from '../../tmux/manager.js';
import type { IStateManager } from '../../types/interfaces.js';
import type { ProjectInstanceState } from '../../types/index.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../../state/instances.js';
import { downloadFileAttachments, buildFileMarkers } from '../../infra/file-downloader.js';
import { PendingMessageTracker, type PendingRuntimeSnapshot } from './pending-message-tracker.js';
import { getDaemonStatus } from '../../app/daemon-service.js';
import { cleanCapture, splitForDiscord, splitForSlack } from '../../capture/parser.js';
import type { CodexIoV2Tracker } from '../events/codex-io-v2.js';
import type { SkillAutoLinker } from '../skills/skill-autolinker.js';
import type { AgentEventHookClient } from '../events/agent-event-hook.js';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { runDoctor, type DoctorResult } from '../../cli/commands/doctor.js';

export interface OrchestratorWorkerProvisioner {
  spawnCodexWorkers(params: {
    projectName: string;
    count: number;
  }): Promise<{
    created: ProjectInstanceState[];
    warnings?: string[];
  }>;
  teardownWorker(params: {
    projectName: string;
    workerInstanceId: string;
  }): Promise<{
    removed: boolean;
    removedInstance?: ProjectInstanceState;
    warning?: string;
  }>;
}

export interface BridgeMessageRouterDeps {
  messaging: MessagingClient;
  tmux: TmuxManager;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  sanitizeInput: (content: string) => string | null;
  ioTracker?: CodexIoV2Tracker;
  skillAutoLinker?: SkillAutoLinker;
  eventHookClient?: AgentEventHookClient;
  doctorRunner?: (options: { fix?: boolean }) => Promise<DoctorResult>;
  backgroundCliRunner?: (args: string[], delayMs?: number) => void;
  orchestratorWorkerProvisioner?: OrchestratorWorkerProvisioner;
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
type MaintenanceCommand =
  | { kind: 'doctor'; fix: boolean }
  | { kind: 'update'; git: boolean }
  | { kind: 'daemon-restart' }
  | { kind: 'repair'; mode: 'default' | 'doctor-only' | 'restart-only' | 'verify' | 'deep' }
  | { kind: 'orchestrator-status' }
  | {
      kind: 'orchestrator-enable';
      supervisorInstanceId?: string;
      workerFinalVisibility?: 'hidden' | 'thread' | 'channel';
    }
  | {
      kind: 'orchestrator-run';
      workerInstanceId: string;
      prompt: string;
      priority?: number;
    }
  | {
      kind: 'orchestrator-spawn';
      count: number;
    }
  | {
      kind: 'orchestrator-remove';
      workerInstanceId: string;
    }
  | { kind: 'orchestrator-remove-all' }
  | { kind: 'orchestrator-worker-info'; workerToken: string }
  | { kind: 'orchestrator-worker-log'; workerToken: string; tailLines?: number }
  | { kind: 'orchestrator-disable' }
  | { kind: 'orchestrator-help'; message: string };
type CodexLongTaskReportMode = 'off' | 'continue' | 'auto' | 'always';
type CodexLanguagePolicyMode = 'off' | 'korean' | 'always';
type OrchestratorDelegationContractMode = 'off' | 'warn' | 'enforce';

interface OrchestratorQueuedTask {
  taskId: string;
  projectName: string;
  supervisorInstanceId: string;
  workerInstanceId: string;
  prompt: string;
  sourceChannelId: string;
  routeHint?: 'reply' | 'thread' | 'memory';
  turnId: string;
  queuedAtMs: number;
  attempts: number;
  nextAttemptAtMs?: number;
  priority: number;
}

interface OrchestratorWorkerActivity {
  atMs: number;
  turnId: string;
  stage: 'dispatched' | 'queued' | 'retry-queued' | 'queue-drained' | 'queue-timeout' | 'dispatch-failed';
  promptSummary: string;
  queueDepth?: number;
}

interface OrchestratorDispatchOrQueueOutcome {
  kind: 'dispatched' | 'queued' | 'queue-full' | 'dispatch-failed';
  turnId: string;
  queueDepth?: number;
  queuePosition?: number;
  immediateFailureQueued?: boolean;
  errorMessage?: string;
}

interface AutoPlannerAssignment {
  task: string;
  prompt: string;
  packetArtifactPath?: string;
}

interface OrchestratorTaskPacketParams {
  projectName: string;
  projectPath: string;
  supervisorInstanceId: string;
  workerInstanceId: string;
  task: string;
  prompt: string;
}

export class BridgeMessageRouter {
  private routeByMessageId: Map<string, RouteMemory> = new Map();
  private routeByConversationKey: Map<string, RouteMemory> = new Map();
  private lastPromptByInstance: Map<string, string> = new Map();
  private lastOrchestratorActivityByWorker: Map<string, OrchestratorWorkerActivity> = new Map();
  private firstSeenOrchestratorWorkerAtMs: Map<string, number> = new Map();
  private lastOrchestratorAutoCleanupAtMsByProject: Map<string, number> = new Map();
  private orchestratorQueueByWorker: Map<string, OrchestratorQueuedTask[]> = new Map();
  private orchestratorQueueDrainInFlight = new Set<string>();
  private orchestratorQueueDrainTimerByWorker = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly maxMessageRoutes = 4000;
  private readonly maxConversationRoutes = 2000;
  private readonly maxPromptMemory = 2000;
  private readonly maxWorkerActivityMemory = 4000;

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

  private promptMemoryKey(projectName: string, instanceId: string): string {
    return `${projectName}:${instanceId}`;
  }

  private rememberPrompt(projectName: string, instanceId: string, prompt: string): void {
    const key = this.promptMemoryKey(projectName, instanceId);
    this.lastPromptByInstance.set(key, prompt);
    this.pruneOldest(this.lastPromptByInstance, this.maxPromptMemory);
  }

  private getRememberedPrompt(projectName: string, instanceId: string): string | undefined {
    const key = this.promptMemoryKey(projectName, instanceId);
    return this.lastPromptByInstance.get(key);
  }

  private workerActivityKey(projectName: string, workerInstanceId: string): string {
    return `${projectName}:${workerInstanceId}`;
  }

  private summarizeOrchestratorWorkerPrompt(prompt: string, maxChars: number = 180): string {
    const compact = this.stripMudcodeControlBlocks(prompt).replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return '(empty)';
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(40, maxChars))}...`;
  }

  private rememberOrchestratorWorkerActivity(params: {
    projectName: string;
    workerInstanceId: string;
    turnId: string;
    stage: OrchestratorWorkerActivity['stage'];
    prompt: string;
    queueDepth?: number;
  }): void {
    const key = this.workerActivityKey(params.projectName, params.workerInstanceId);
    this.rememberOrchestratorWorkerFirstSeen(params.projectName, params.workerInstanceId);
    this.lastOrchestratorActivityByWorker.set(key, {
      atMs: Date.now(),
      turnId: params.turnId,
      stage: params.stage,
      promptSummary: this.summarizeOrchestratorWorkerPrompt(params.prompt),
      ...(typeof params.queueDepth === 'number' && Number.isFinite(params.queueDepth)
        ? { queueDepth: Math.max(0, Math.trunc(params.queueDepth)) }
        : {}),
    });
    this.pruneOldest(this.lastOrchestratorActivityByWorker, this.maxWorkerActivityMemory);
  }

  private rememberOrchestratorWorkerFirstSeen(projectName: string, workerInstanceId: string, atMs?: number): void {
    const key = this.workerActivityKey(projectName, workerInstanceId);
    if (this.firstSeenOrchestratorWorkerAtMs.has(key)) return;
    this.firstSeenOrchestratorWorkerAtMs.set(key, atMs ?? Date.now());
    this.pruneOldest(this.firstSeenOrchestratorWorkerAtMs, this.maxWorkerActivityMemory);
  }

  private getOrchestratorWorkerFirstSeenAt(projectName: string, workerInstanceId: string): number | undefined {
    return this.firstSeenOrchestratorWorkerAtMs.get(this.workerActivityKey(projectName, workerInstanceId));
  }

  private getOrchestratorWorkerActivity(
    projectName: string,
    workerInstanceId: string,
  ): OrchestratorWorkerActivity | undefined {
    return this.lastOrchestratorActivityByWorker.get(this.workerActivityKey(projectName, workerInstanceId));
  }

  private formatWorkerActivityStage(stage: OrchestratorWorkerActivity['stage']): string {
    if (stage === 'dispatched') return 'dispatched';
    if (stage === 'queued') return 'queued';
    if (stage === 'retry-queued') return 'retry queued';
    if (stage === 'queue-drained') return 'queue drained';
    if (stage === 'queue-timeout') return 'queue timeout';
    return 'dispatch failed';
  }

  private buildWorkerQueueHeadSummary(
    projectName: string,
    workerInstanceId: string,
    maxChars: number = 100,
  ): string | undefined {
    const head = this.peekOrchestratorTask(projectName, workerInstanceId);
    if (!head) return undefined;
    return `head(${this.formatAge(Date.now() - head.queuedAtMs)}): ${this.summarizeOrchestratorWorkerPrompt(head.prompt, maxChars)}`;
  }

  private parseUtilityCommand(content: string): 'retry' | 'health' | 'snapshot' | 'io' | undefined {
    const normalized = content.trim().toLowerCase();
    if (normalized === '/retry') return 'retry';
    if (normalized === '/health') return 'health';
    if (normalized === '/snapshot') return 'snapshot';
    if (normalized === '/io') return 'io';
    return undefined;
  }

  private parseOrchestratorRunPrompt(rawPrompt: string): { prompt: string; priority?: number } | undefined {
    let prompt = rawPrompt.trim();
    let priority: number | undefined;
    const priorityNamed = prompt.match(/^(?:--priority(?:=|\s+))(high|normal|low)\s+([\s\S]+)$/i);
    if (priorityNamed) {
      const named = (priorityNamed[1] || '').toLowerCase();
      priority = named === 'high' ? 2 : named === 'low' ? -2 : 0;
      prompt = (priorityNamed[2] || '').trim();
    } else {
      const priorityShort = prompt.match(/^(p0|p1|p2)\s+([\s\S]+)$/i);
      if (priorityShort) {
        const short = (priorityShort[1] || '').toLowerCase();
        priority = short === 'p2' ? 2 : short === 'p0' ? -2 : 0;
        prompt = (priorityShort[2] || '').trim();
      }
    }
    if (!prompt) return undefined;
    return {
      prompt,
      ...(priority !== undefined ? { priority } : {}),
    };
  }

  private parseSubagentsAliasCommand(content: string): MaintenanceCommand | undefined {
    const trimmed = content.trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return undefined;
    const command = parts[0]!.toLowerCase();
    if (command !== '/subagents' && command !== '/subagent') return undefined;

    const sub = (parts[1] || 'list').toLowerCase();
    if (sub === 'list' || sub === 'ls' || sub === 'status' || sub === 'show') {
      return { kind: 'orchestrator-status' };
    }
    if (sub === 'spawn' || sub === 'add') {
      const raw = (parts[2] || '').trim();
      if (!raw) return { kind: 'orchestrator-spawn', count: 1 };
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents spawn [count>=1]`',
        };
      }
      return {
        kind: 'orchestrator-spawn',
        count: Math.min(15, Math.trunc(parsed)),
      };
    }
    if (sub === 'send' || sub === 'run' || sub === 'steer') {
      const runMatch = trimmed.match(/^\/subagents?\s+(?:send|run|steer)\s+(\S+)\s+([\s\S]+)$/i);
      if (!runMatch) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents send <workerInstanceId> [--priority high|normal|low] <task>`',
        };
      }
      const workerInstanceId = (runMatch[1] || '').trim();
      const parsed = this.parseOrchestratorRunPrompt(runMatch[2] || '');
      if (!workerInstanceId || !parsed) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents send <workerInstanceId> [--priority high|normal|low] <task>`',
        };
      }
      return {
        kind: 'orchestrator-run',
        workerInstanceId,
        prompt: parsed.prompt,
        ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      };
    }
    if (sub === 'info') {
      const workerToken = (parts[2] || '').trim();
      if (!workerToken) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents info <workerInstanceId|#index>`',
        };
      }
      return {
        kind: 'orchestrator-worker-info',
        workerToken,
      };
    }
    if (sub === 'log' || sub === 'logs') {
      const workerToken = (parts[2] || '').trim();
      if (!workerToken) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents log <workerInstanceId|#index> [tailLines]`',
        };
      }
      const rawTail = (parts[3] || '').trim();
      if (!rawTail) {
        return {
          kind: 'orchestrator-worker-log',
          workerToken,
        };
      }
      const parsedTail = Number(rawTail);
      if (!Number.isFinite(parsedTail) || parsedTail < 20) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents log <workerInstanceId|#index> [tailLines>=20]`',
        };
      }
      return {
        kind: 'orchestrator-worker-log',
        workerToken,
        tailLines: Math.min(500, Math.trunc(parsedTail)),
      };
    }
    if (sub === 'kill' || sub === 'remove' || sub === 'rm' || sub === 'teardown') {
      const target = (parts[2] || '').trim();
      if (!target) {
        return {
          kind: 'orchestrator-help',
          message: '⚠️ Usage: `/subagents kill <workerInstanceId|all>`',
        };
      }
      if (target.toLowerCase() === 'all') {
        return { kind: 'orchestrator-remove-all' };
      }
      return {
        kind: 'orchestrator-remove',
        workerInstanceId: target,
      };
    }
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      return {
        kind: 'orchestrator-help',
        message: [
          '🧩 `/subagents` aliases',
          '- `/subagents list` -> `/orchestrator status`',
          '- `/subagents spawn [count]` -> `/orchestrator spawn [count]`',
          '- `/subagents send <worker> <task>` -> `/orchestrator run <worker> <task>`',
          '- `/subagents steer <worker> <task>` -> `/orchestrator run <worker> <task>`',
          '- `/subagents info <worker|#index>` -> worker runtime detail',
          '- `/subagents log <worker|#index> [tailLines]` -> worker tmux tail',
          '- `/subagents kill <worker|all>` -> `/orchestrator remove <worker>` / remove-all',
        ].join('\n'),
      };
    }
    return {
      kind: 'orchestrator-help',
      message:
        '⚠️ Unknown `/subagents` command. Use `list`, `spawn`, `send`, `steer`, `info`, `log`, or `kill`.',
    };
  }

  private parseMaintenanceCommand(content: string): MaintenanceCommand | undefined {
    const parts = content.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return undefined;
    const command = parts[0]!.toLowerCase();
    const manualOrchestratorCommandsEnabled = this.resolveOrchestratorManualCommandsEnabled();

    if (command === '/doctor') {
      const fix = parts.slice(1).some((part) => {
        const token = part.toLowerCase();
        return token === 'fix' || token === '--fix';
      });
      return { kind: 'doctor', fix };
    }

    if (command === '/update') {
      const git = parts.slice(1).some((part) => {
        const token = part.toLowerCase();
        return token === 'git' || token === '--git';
      });
      return { kind: 'update', git };
    }

    if (command === '/daemon-restart' || command === '/restart-daemon') {
      return { kind: 'daemon-restart' };
    }

    if (command === '/repair' || command === '/self-heal') {
      const modeToken = (parts[1] || '').trim().toLowerCase();
      if (!modeToken || modeToken === 'default') {
        return { kind: 'repair', mode: 'default' };
      }
      if (modeToken === 'doctor' || modeToken === 'doctor-only') {
        return { kind: 'repair', mode: 'doctor-only' };
      }
      if (modeToken === 'restart' || modeToken === 'restart-only') {
        return { kind: 'repair', mode: 'restart-only' };
      }
      if (modeToken === 'verify' || modeToken === 'check') {
        return { kind: 'repair', mode: 'verify' };
      }
      if (modeToken === 'deep' || modeToken === 'full') {
        return { kind: 'repair', mode: 'deep' };
      }
      return {
        kind: 'orchestrator-help',
        message: '⚠️ Usage: `/repair [doctor-only|restart-only|verify|deep]`',
      };
    }

    const subagentsAlias = this.parseSubagentsAliasCommand(content);
    if (subagentsAlias) {
      if (!manualOrchestratorCommandsEnabled) {
        return {
          kind: 'orchestrator-help',
          message: this.buildOrchestratorManualCommandDisabledMessage('/subagents'),
        };
      }
      return subagentsAlias;
    }

    if (command === '/orchestrator' || command === '/orch') {
      if (!manualOrchestratorCommandsEnabled) {
        return {
          kind: 'orchestrator-help',
          message: this.buildOrchestratorManualCommandDisabledMessage('/orchestrator'),
        };
      }
      const sub = (parts[1] || 'status').toLowerCase();
      if (sub === 'status' || sub === 'show') return { kind: 'orchestrator-status' };
      if (sub === 'disable' || sub === 'off') return { kind: 'orchestrator-disable' };
      if (sub === 'run') {
        const runMatch = content.trim().match(/^\/(?:orchestrator|orch)\s+run\s+(\S+)\s+([\s\S]+)$/i);
        if (!runMatch) {
          return {
            kind: 'orchestrator-help',
            message: '⚠️ Usage: `/orchestrator run <workerInstanceId> [--priority high|normal|low] <task>`',
          };
        }
        const workerInstanceId = (runMatch[1] || '').trim();
        const parsed = this.parseOrchestratorRunPrompt(runMatch[2] || '');
        if (!workerInstanceId || !parsed) {
          return {
            kind: 'orchestrator-help',
            message: '⚠️ Usage: `/orchestrator run <workerInstanceId> [--priority high|normal|low] <task>`',
          };
        }
        return {
          kind: 'orchestrator-run',
          workerInstanceId,
          prompt: parsed.prompt,
          ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
        };
      }
      if (sub === 'spawn' || sub === 'add') {
        const raw = (parts[2] || '').trim();
        if (!raw) {
          return {
            kind: 'orchestrator-spawn',
            count: 1,
          };
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return {
            kind: 'orchestrator-help',
            message: '⚠️ Usage: `/orchestrator spawn [count>=1]`',
          };
        }
        return {
          kind: 'orchestrator-spawn',
          count: Math.min(15, Math.trunc(parsed)),
        };
      }
      if (sub === 'remove' || sub === 'rm' || sub === 'teardown') {
        const workerInstanceId = (parts[2] || '').trim();
        if (!workerInstanceId) {
          return {
            kind: 'orchestrator-help',
            message: '⚠️ Usage: `/orchestrator remove <workerInstanceId>`',
          };
        }
        return {
          kind: 'orchestrator-remove',
          workerInstanceId,
        };
      }
      if (sub === 'enable' || sub === 'on') {
        let supervisorInstanceId: string | undefined;
        let workerFinalVisibility: 'hidden' | 'thread' | 'channel' | undefined;
        for (const tokenRaw of parts.slice(2)) {
          const token = tokenRaw.trim();
          if (!token) continue;
          const lower = token.toLowerCase();
          if (lower.startsWith('supervisor=')) {
            const value = token.slice('supervisor='.length).trim();
            if (value) supervisorInstanceId = value;
            continue;
          }
          if (lower === 'hidden' || lower === 'thread' || lower === 'channel') {
            workerFinalVisibility = lower;
            continue;
          }
          if (!supervisorInstanceId) {
            supervisorInstanceId = token;
            continue;
          }
          return {
            kind: 'orchestrator-help',
            message:
              '⚠️ Invalid /orchestrator enable arguments. Usage: `/orchestrator enable [supervisorInstanceId|supervisor=<id>] [hidden|thread|channel]`',
          };
        }
        return {
          kind: 'orchestrator-enable',
          ...(supervisorInstanceId ? { supervisorInstanceId } : {}),
          ...(workerFinalVisibility ? { workerFinalVisibility } : {}),
        };
      }
      return {
        kind: 'orchestrator-help',
        message:
          '⚠️ Unknown /orchestrator command. Use `/orchestrator status`, `/orchestrator run`, `/orchestrator spawn`, `/orchestrator remove`, `/orchestrator enable`, or `/orchestrator disable`.',
      };
    }

    return undefined;
  }

  private buildOrchestratorManualCommandDisabledMessage(command: '/orchestrator' | '/subagents'): string {
    return [
      'ℹ️ Manual orchestrator commands are disabled in Discord.',
      `ignored: \`${command}\``,
      'Auto orchestration is handled by runtime policy and prompt flow.',
      'To re-enable manual commands, set `AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS=1` and restart daemon.',
    ].join('\n');
  }

  private buildOrchestratorStatusSummary(
    project: ReturnType<typeof normalizeProjectState>,
  ): string {
    const orchestrator = project.orchestrator;
    if (!orchestrator?.enabled) {
      return [
        '🧭 Orchestrator: disabled',
        'Use `/orchestrator enable [supervisorInstanceId] [hidden|thread|channel]` to enable.',
      ].join('\n');
    }

    const supervisor = orchestrator.supervisorInstanceId || '(unset)';
    const workers = this.resolveOrchestratorWorkerIds(project);
    const visibility = orchestrator.workerFinalVisibility || 'hidden';
    const maxConcurrency = this.resolveOrchestratorQosMaxConcurrency(project);
    const contextBudgetChars = this.resolveOrchestratorContextBudgetChars();
    const rollingSummaryItems = this.resolveOrchestratorRollingSummaryMaxItems();
    const rollingSummaryChars = this.resolveOrchestratorRollingSummaryMaxChars();
    const packetInlineMaxChars = this.resolveOrchestratorPacketInlineMaxChars();
    const packetArtifactEnabled = this.resolveOrchestratorPacketArtifactEnabled();
    const nowMs = Date.now();
    let activeWorkers = 0;
    let queuedWorkers = 0;
    let totalQueueDepth = 0;
    const workerLine =
      workers.length > 0 ? workers.map((id) => `\`${id}\``).join(', ') : '(none)';
    const workerIndexLine =
      workers.length > 0 ? workers.map((id, index) => `#${index + 1}->\`${id}\``).join(', ') : '(none)';
    const workerRuntimeLines = workers.flatMap((workerId, index) => {
      const worker = getProjectInstance(project, workerId);
      if (!worker) return [`- #${index + 1} \`${workerId}\`: missing`];
      const runtime = this.getPendingRuntimeSnapshot(project.projectName, worker.agentType, worker.instanceId);
      const stage = runtime.latestStage || runtime.oldestStage || runtime.lastTerminalStage || 'idle';
      const queue = this.getOrchestratorQueueSnapshot(project.projectName, workerId);
      const queueHead = this.buildWorkerQueueHeadSummary(project.projectName, workerId, 90);
      const activity = this.getOrchestratorWorkerActivity(project.projectName, workerId);
      totalQueueDepth += queue.depth;
      if (queue.depth > 0) queuedWorkers += 1;
      if (runtime.pendingDepth > 0) activeWorkers += 1;
      const queueText =
        queue.depth > 0
          ? `, queue=${queue.depth}${queue.oldestAgeMs !== undefined ? ` (oldest ${this.formatAge(queue.oldestAgeMs)})` : ''}`
          : ', queue=0';
      const statusLine = `- #${index + 1} \`${workerId}\`: pending=${runtime.pendingDepth}, stage=${stage}${queueText}`;
      const detailLines: string[] = [];
      if (activity) {
        detailLines.push(
          `  ↳ recent: ${this.formatWorkerActivityStage(activity.stage)} ${this.formatAge(nowMs - activity.atMs)} ago (turn \`${activity.turnId}\`)`,
        );
        detailLines.push(`  ↳ task: ${activity.promptSummary}`);
      } else {
        detailLines.push('  ↳ recent: (none)');
      }
      if (queueHead) {
        detailLines.push(`  ↳ ${queueHead}`);
      }
      return [statusLine, ...detailLines];
    });
    return [
      '🧭 Orchestrator: enabled',
      `supervisor: \`${supervisor}\``,
      `workers(${workers.length}): ${workerLine}`,
      `worker index: ${workerIndexLine}`,
      `worker final visibility: \`${visibility}\``,
      `worker qos max concurrency: \`${maxConcurrency}\``,
      `context budget: \`${contextBudgetChars}\` chars`,
      `rolling summary: items=\`${rollingSummaryItems}\`, chars=\`${rollingSummaryChars}\``,
      `task packet inline max: \`${packetInlineMaxChars}\` chars`,
      `task packet artifact enabled: \`${packetArtifactEnabled ? 'on' : 'off'}\``,
      `worker summary: active=\`${activeWorkers}\`, queued=\`${queuedWorkers}\`, totalQueueDepth=\`${totalQueueDepth}\``,
      ...(workerRuntimeLines.length > 0 ? ['worker runtime:', ...workerRuntimeLines] : []),
    ].join('\n');
  }

  private buildKnownWorkerList(project: ReturnType<typeof normalizeProjectState>): string {
    const workers = this.resolveOrchestratorWorkerIds(project);
    if (workers.length === 0) return '(none)';
    return workers.map((id) => `\`${id}\``).join(', ');
  }

  private resolveWorkerForCommand(params: {
    project: ReturnType<typeof normalizeProjectState>;
    workerToken: string;
  }): { workerInstanceId?: string; worker?: ProjectInstanceState; error?: string } {
    const workerInstanceId = this.resolveWorkerInstanceIdFromToken(params.project, params.workerToken);
    if (!workerInstanceId) {
      return {
        error:
          `Worker \`${params.workerToken}\` is not registered. Known workers: ` +
          this.buildKnownWorkerList(params.project),
      };
    }
    const worker = getProjectInstance(params.project, workerInstanceId);
    if (!worker) {
      return {
        error: `Worker instance \`${workerInstanceId}\` not found.`,
      };
    }
    return { workerInstanceId, worker };
  }

  private resolveOrchestratorWorkerIds(project: ReturnType<typeof normalizeProjectState>): string[] {
    const orchestrator = project.orchestrator;
    if (!orchestrator?.enabled) return [];
    const known = new Set(listProjectInstances(project).map((instance) => instance.instanceId));
    const configured = (orchestrator.workerInstanceIds || []).filter((id) => known.has(id));
    if (configured.length > 0) return [...new Set(configured)];

    const supervisor = orchestrator.supervisorInstanceId;
    if (!supervisor) return [];
    return listProjectInstances(project)
      .filter((instance) => instance.agentType === 'codex' && instance.instanceId !== supervisor)
      .map((instance) => instance.instanceId);
  }

  private resolveSubagentsLogTailLines(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 20) {
      return Math.min(500, Math.trunc(configured));
    }
    return 120;
  }

  private resolveWorkerInstanceIdFromToken(
    project: ReturnType<typeof normalizeProjectState>,
    workerToken: string,
  ): string | undefined {
    const token = workerToken.trim();
    if (!token) return undefined;
    const workers = this.resolveOrchestratorWorkerIds(project);
    if (workers.includes(token)) return token;

    const indexed = token.match(/^#?(\d+)$/);
    if (!indexed) return undefined;
    const index = Number.parseInt(indexed[1] || '', 10);
    if (!Number.isFinite(index) || index < 1) return undefined;
    return workers[index - 1];
  }

  private buildOrchestratorQueueKey(projectName: string, workerInstanceId: string): string {
    return `${projectName}:${workerInstanceId}`;
  }

  private resolveOrchestratorQueueMaxDepth(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_DEPTH', 32);
    return Math.min(200, Math.max(1, value));
  }

  private resolveOrchestratorQueueDrainIntervalMs(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS', 1200);
    return Math.min(10_000, Math.max(50, value));
  }

  private resolveOrchestratorQueueWaitTimeoutMs(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QUEUE_WAIT_TIMEOUT_MS', 10 * 60 * 1000);
    return Math.min(24 * 60 * 60 * 1000, Math.max(1_000, value));
  }

  private resolveOrchestratorQueueMaxRetries(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_RETRIES', 2);
    return Math.min(10, Math.max(0, value));
  }

  private resolveOrchestratorQueueRetryBackoffMs(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QUEUE_RETRY_BACKOFF_MS', 1500);
    return Math.min(120_000, Math.max(200, value));
  }

  private resolveOrchestratorQosMaxConcurrency(project: ReturnType<typeof normalizeProjectState>): number {
    const fromState = project.orchestrator?.qos?.maxConcurrentWorkers;
    if (typeof fromState === 'number' && Number.isFinite(fromState) && fromState >= 1) {
      return Math.min(16, Math.max(1, Math.trunc(fromState)));
    }
    const fromEnv = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_QOS_MAX_CONCURRENCY', 2);
    return Math.min(16, Math.max(1, fromEnv));
  }

  private resolveOrchestratorWorkerPriority(
    project: ReturnType<typeof normalizeProjectState>,
    workerInstanceId: string,
    explicitPriority?: number,
  ): number {
    if (typeof explicitPriority === 'number' && Number.isFinite(explicitPriority)) {
      return Math.min(10, Math.max(-10, Math.trunc(explicitPriority)));
    }
    const fromState = project.orchestrator?.qos?.workerPriorityByInstanceId?.[workerInstanceId];
    if (typeof fromState === 'number' && Number.isFinite(fromState)) {
      return Math.min(10, Math.max(-10, Math.trunc(fromState)));
    }
    return 0;
  }

  private getOrchestratorQueue(projectName: string, workerInstanceId: string): OrchestratorQueuedTask[] {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    const queue = this.orchestratorQueueByWorker.get(key);
    if (queue) return queue;
    const next: OrchestratorQueuedTask[] = [];
    this.orchestratorQueueByWorker.set(key, next);
    return next;
  }

  private getOrchestratorQueueSnapshot(projectName: string, workerInstanceId: string): {
    depth: number;
    oldestAgeMs?: number;
  } {
    const queue = this.orchestratorQueueByWorker.get(this.buildOrchestratorQueueKey(projectName, workerInstanceId));
    if (!queue || queue.length === 0) return { depth: 0 };
    const oldest = queue[0];
    if (!oldest) return { depth: queue.length };
    return {
      depth: queue.length,
      oldestAgeMs: Math.max(0, Date.now() - oldest.queuedAtMs),
    };
  }

  private enqueueOrchestratorTask(task: OrchestratorQueuedTask):
    | { ok: true; queueDepth: number; position: number }
    | { ok: false; reason: 'full' } {
    const queue = this.getOrchestratorQueue(task.projectName, task.workerInstanceId);
    const maxDepth = this.resolveOrchestratorQueueMaxDepth();
    if (queue.length >= maxDepth) {
      return { ok: false, reason: 'full' };
    }
    let insertedPosition = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const existing = queue[i];
      if (!existing) continue;
      if (task.priority > existing.priority) {
        queue.splice(i, 0, task);
        insertedPosition = i + 1;
        break;
      }
    }
    if (insertedPosition < 0) {
      queue.push(task);
      insertedPosition = queue.length;
    }
    return {
      ok: true,
      queueDepth: queue.length,
      position: insertedPosition,
    };
  }

  private dequeueOrchestratorTask(projectName: string, workerInstanceId: string): OrchestratorQueuedTask | undefined {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    const queue = this.orchestratorQueueByWorker.get(key);
    if (!queue || queue.length === 0) return undefined;
    const task = queue.shift();
    if (queue.length === 0) {
      this.orchestratorQueueByWorker.delete(key);
    }
    return task;
  }

  private peekOrchestratorTask(projectName: string, workerInstanceId: string): OrchestratorQueuedTask | undefined {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    return this.orchestratorQueueByWorker.get(key)?.[0];
  }

  private clearOrchestratorQueueForProject(projectName: string): void {
    for (const key of this.orchestratorQueueByWorker.keys()) {
      if (key.startsWith(`${projectName}:`)) {
        this.orchestratorQueueByWorker.delete(key);
      }
    }
    for (const [key, timer] of this.orchestratorQueueDrainTimerByWorker.entries()) {
      if (!key.startsWith(`${projectName}:`)) continue;
      clearTimeout(timer);
      this.orchestratorQueueDrainTimerByWorker.delete(key);
    }
    for (const key of this.orchestratorQueueDrainInFlight) {
      if (key.startsWith(`${projectName}:`)) {
        this.orchestratorQueueDrainInFlight.delete(key);
      }
    }
    for (const key of this.lastOrchestratorActivityByWorker.keys()) {
      if (key.startsWith(`${projectName}:`)) {
        this.lastOrchestratorActivityByWorker.delete(key);
      }
    }
    for (const key of this.firstSeenOrchestratorWorkerAtMs.keys()) {
      if (key.startsWith(`${projectName}:`)) {
        this.firstSeenOrchestratorWorkerAtMs.delete(key);
      }
    }
    this.lastOrchestratorAutoCleanupAtMsByProject.delete(projectName);
  }

  private clearOrchestratorQueueForWorker(projectName: string, workerInstanceId: string): void {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    this.orchestratorQueueByWorker.delete(key);
    const timer = this.orchestratorQueueDrainTimerByWorker.get(key);
    if (timer) {
      clearTimeout(timer);
      this.orchestratorQueueDrainTimerByWorker.delete(key);
    }
    this.orchestratorQueueDrainInFlight.delete(key);
    this.lastOrchestratorActivityByWorker.delete(this.workerActivityKey(projectName, workerInstanceId));
    this.firstSeenOrchestratorWorkerAtMs.delete(this.workerActivityKey(projectName, workerInstanceId));
  }

  private scheduleOrchestratorQueueDrain(projectName: string, workerInstanceId: string, delayMs?: number): void {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    if (this.orchestratorQueueDrainTimerByWorker.has(key)) return;
    const delay = Math.max(0, Math.trunc(delayMs ?? this.resolveOrchestratorQueueDrainIntervalMs()));
    const timer = setTimeout(() => {
      this.orchestratorQueueDrainTimerByWorker.delete(key);
      void this.drainOrchestratorQueueWorker(projectName, workerInstanceId);
    }, delay);
    timer.unref?.();
    this.orchestratorQueueDrainTimerByWorker.set(key, timer);
  }

  private async notifyOrchestratorQueueEvent(channelId: string, message: string): Promise<void> {
    try {
      await this.deps.messaging.sendToChannel(channelId, message);
    } catch (error) {
      console.warn(`Failed to send orchestrator queue notice: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async drainOrchestratorQueueWorker(projectName: string, workerInstanceId: string): Promise<void> {
    const key = this.buildOrchestratorQueueKey(projectName, workerInstanceId);
    if (this.orchestratorQueueDrainInFlight.has(key)) return;
    this.orchestratorQueueDrainInFlight.add(key);

    try {
      while (true) {
        const head = this.peekOrchestratorTask(projectName, workerInstanceId);
        if (!head) return;

        const now = Date.now();
        const waitTimeoutMs = this.resolveOrchestratorQueueWaitTimeoutMs();
        if (now - head.queuedAtMs > waitTimeoutMs) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          this.rememberOrchestratorWorkerActivity({
            projectName,
            workerInstanceId,
            turnId: head.turnId,
            stage: 'queue-timeout',
            prompt: head.prompt,
            queueDepth: this.getOrchestratorQueueSnapshot(projectName, workerInstanceId).depth,
          });
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            `⚠️ Orchestrator queue timeout: dropped worker task \`${head.workerInstanceId}\` (queued ${this.formatAge(now - head.queuedAtMs)} ago).`,
          );
          continue;
        }

        if (head.nextAttemptAtMs && now < head.nextAttemptAtMs) {
          this.scheduleOrchestratorQueueDrain(projectName, workerInstanceId, head.nextAttemptAtMs - now);
          return;
        }

        const project = this.deps.stateManager.getProject(projectName);
        if (!project) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            `⚠️ Orchestrator queue dropped task for \`${head.workerInstanceId}\`: project \`${projectName}\` not found.`,
          );
          continue;
        }
        const normalizedProject = normalizeProjectState(project);
        const orchestrator = normalizedProject.orchestrator;
        if (!orchestrator?.enabled) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            `⚠️ Orchestrator queue dropped task for \`${head.workerInstanceId}\`: orchestrator is disabled.`,
          );
          continue;
        }
        if (orchestrator.supervisorInstanceId && orchestrator.supervisorInstanceId !== head.supervisorInstanceId) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            `⚠️ Orchestrator queue dropped task for \`${head.workerInstanceId}\`: supervisor changed to \`${orchestrator.supervisorInstanceId}\`.`,
          );
          continue;
        }

        const worker = getProjectInstance(normalizedProject, workerInstanceId);
        if (!worker) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            `⚠️ Orchestrator queue dropped task: worker \`${workerInstanceId}\` is missing.`,
          );
          continue;
        }

        const maxConcurrency = this.resolveOrchestratorQosMaxConcurrency(normalizedProject);
        const knownWorkers = this.resolveOrchestratorWorkerIds(normalizedProject);
        const activeWorkerCount = knownWorkers.reduce((count, candidateId) => {
          const candidate = getProjectInstance(normalizedProject, candidateId);
          if (!candidate) return count;
          const snapshot = this.getPendingRuntimeSnapshot(projectName, candidate.agentType, candidate.instanceId);
          return snapshot.pendingDepth > 0 ? count + 1 : count;
        }, 0);
        if (activeWorkerCount >= maxConcurrency) {
          this.scheduleOrchestratorQueueDrain(projectName, workerInstanceId);
          return;
        }

        const runtime = this.getPendingRuntimeSnapshot(projectName, worker.agentType, worker.instanceId);
        if (runtime.pendingDepth > 0) {
          this.scheduleOrchestratorQueueDrain(projectName, workerInstanceId);
          return;
        }

        const dispatched = await this.dispatchPromptToInstance({
          projectName,
          normalizedProject,
          instance: worker,
          prompt: head.prompt,
          turnId: head.turnId,
          routeHint: head.routeHint,
          sourceChannelId: head.sourceChannelId,
        });
        if (dispatched.ok) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          const queueDepth = this.getOrchestratorQueueSnapshot(projectName, workerInstanceId).depth;
          this.rememberOrchestratorWorkerActivity({
            projectName,
            workerInstanceId: worker.instanceId,
            turnId: head.turnId,
            stage: 'queue-drained',
            prompt: head.prompt,
            queueDepth,
          });
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            [
              `🚀 Dispatched queued task to worker \`${worker.instanceId}\``,
              `turnId: \`${head.turnId}\``,
              `queue remaining: \`${queueDepth}\``,
            ].join('\n'),
          );
          continue;
        }

        head.attempts += 1;
        const maxRetries = this.resolveOrchestratorQueueMaxRetries();
        if (head.attempts > maxRetries) {
          this.dequeueOrchestratorTask(projectName, workerInstanceId);
          this.rememberOrchestratorWorkerActivity({
            projectName,
            workerInstanceId: worker.instanceId,
            turnId: head.turnId,
            stage: 'dispatch-failed',
            prompt: head.prompt,
            queueDepth: this.getOrchestratorQueueSnapshot(projectName, workerInstanceId).depth,
          });
          await this.notifyOrchestratorQueueEvent(
            head.sourceChannelId,
            this.buildDeliveryFailureGuidance(
              projectName,
              dispatched.errorMessage || `queued worker dispatch failed after ${head.attempts} attempt(s)`,
            ),
          );
          continue;
        }

        const backoffMs = this.resolveOrchestratorQueueRetryBackoffMs();
        head.nextAttemptAtMs = Date.now() + backoffMs;
        this.rememberOrchestratorWorkerActivity({
          projectName,
          workerInstanceId: worker.instanceId,
          turnId: head.turnId,
          stage: 'retry-queued',
          prompt: head.prompt,
          queueDepth: this.getOrchestratorQueueSnapshot(projectName, workerInstanceId).depth,
        });
        await this.notifyOrchestratorQueueEvent(
          head.sourceChannelId,
          `⚠️ Worker \`${worker.instanceId}\` dispatch failed (attempt ${head.attempts}/${maxRetries}); retrying in ${Math.ceil(backoffMs / 1000)}s.`,
        );
        this.scheduleOrchestratorQueueDrain(projectName, workerInstanceId, backoffMs);
        return;
      }
    } finally {
      this.orchestratorQueueDrainInFlight.delete(key);
      if (this.peekOrchestratorTask(projectName, workerInstanceId)) {
        this.scheduleOrchestratorQueueDrain(projectName, workerInstanceId);
      }
    }
  }

  private resolveCodexOrchestratorEnableConfig(params: {
    project: ReturnType<typeof normalizeProjectState>;
    currentInstanceId: string;
    requestedSupervisorInstanceId?: string;
    requestedWorkerFinalVisibility?: 'hidden' | 'thread' | 'channel';
  }):
    | {
        supervisorInstanceId: string;
        workerInstanceIds: string[];
        workerFinalVisibility: 'hidden' | 'thread' | 'channel';
      }
    | { error: string } {
    const codexInstances = listProjectInstances(params.project).filter((instance) => instance.agentType === 'codex');
    if (codexInstances.length === 0) {
      return { error: 'No codex instances found in this project.' };
    }

    const requested = params.requestedSupervisorInstanceId;
    const requestedFound = requested ? codexInstances.find((instance) => instance.instanceId === requested) : undefined;
    if (requested && !requestedFound) {
      return { error: `Supervisor instance \`${requested}\` is not a codex instance in this project.` };
    }

    const currentFound = codexInstances.find((instance) => instance.instanceId === params.currentInstanceId);
    const supervisorInstanceId =
      requestedFound?.instanceId ||
      currentFound?.instanceId ||
      codexInstances[0]!.instanceId;

    const workerInstanceIds = codexInstances
      .map((instance) => instance.instanceId)
      .filter((instanceId) => instanceId !== supervisorInstanceId);

    return {
      supervisorInstanceId,
      workerInstanceIds,
      workerFinalVisibility: params.requestedWorkerFinalVisibility || 'hidden',
    };
  }

  private buildOrchestratorTurnId(params: {
    projectName: string;
    supervisorInstanceId: string;
    workerInstanceId: string;
  }): string {
    const now = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `orch-${params.projectName}-${params.supervisorInstanceId}-${params.workerInstanceId}-${now}-${rand}`;
  }

  private resolveOrchestratorAutoEnable(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE', true);
  }

  private resolveOrchestratorManualCommandsEnabled(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS', false);
  }

  private resolveOrchestratorAutoVisibility(): 'hidden' | 'thread' | 'channel' {
    const raw = (process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY || '').trim().toLowerCase();
    if (raw === 'hidden' || raw === 'thread' || raw === 'channel') return raw;
    return 'hidden';
  }

  private resolveOrchestratorAutoDispatchMode(): CodexLongTaskReportMode {
    const raw = (process.env.AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'continue' || raw === 'auto' || raw === 'always') {
      return raw;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) return 'auto';
    if (['0', 'false', 'no'].includes(raw)) return 'off';
    return 'auto';
  }

  private resolveOrchestratorAutoDispatchMaxWorkers(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS', 1);
    return Math.min(15, Math.max(1, value));
  }

  private resolveOrchestratorAutoPlannerEnabled(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER', true);
  }

  private resolveOrchestratorAutoSpawnEnabled(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN', true);
  }

  private resolveOrchestratorAutoSpawnWorkers(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS', 2);
    return Math.min(15, Math.max(1, value));
  }

  private resolveOrchestratorAutoCleanupUnusedWorkers(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_UNUSED_WORKERS', true);
  }

  private resolveOrchestratorAutoCleanupIntervalMs(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_INTERVAL_MS', 60_000);
    return Math.min(60 * 60 * 1000, Math.max(5_000, value));
  }

  private resolveOrchestratorAutoCleanupIdleMs(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_IDLE_MS', 5 * 60 * 1000);
    return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(60_000, value));
  }

  private resolveOrchestratorAutoCleanupMaxRemovals(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_MAX_REMOVALS', 2);
    return Math.min(15, Math.max(1, value));
  }

  private resolveOrchestratorPlannerPromptMaxChars(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER_PROMPT_MAX_CHARS', 1600);
    return Math.min(4000, Math.max(500, value));
  }

  private resolveOrchestratorContextBudgetChars(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS', 2600);
    return Math.min(12000, Math.max(800, value));
  }

  private resolveOrchestratorRollingSummaryMaxItems(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_ITEMS', 6);
    return Math.min(16, Math.max(2, value));
  }

  private resolveOrchestratorRollingSummaryMaxChars(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_CHARS', 900);
    return Math.min(2400, Math.max(300, value));
  }

  private resolveOrchestratorPacketInlineMaxChars(): number {
    const value = this.getEnvInt('AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS', 1800);
    return Math.min(8000, Math.max(400, value));
  }

  private resolveOrchestratorPacketArtifactEnabled(): boolean {
    return this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_PACKET_ARTIFACT_ENABLED', true);
  }

  private resolveOrchestratorDelegationContractMode(): OrchestratorDelegationContractMode {
    const raw = (process.env.AGENT_DISCORD_ORCHESTRATOR_DELEGATION_CONTRACT_MODE || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'warn' || raw === 'enforce') return raw;
    if (['0', 'false', 'no'].includes(raw)) return 'off';
    if (['1', 'true', 'yes', 'on'].includes(raw)) return 'enforce';
    return 'warn';
  }

  private isOrchestratorDelegationContractPrompt(prompt: string): boolean {
    return /\[mudcode orchestrator-plan\]/i.test(prompt) || /\[mudcode delegation-contract\]/i.test(prompt);
  }

  private stripMudcodeControlBlocks(prompt: string): string {
    const stripped = prompt
      .replace(/\[mudcode [a-z0-9_-]+\][\s\S]*?\[\/mudcode [a-z0-9_-]+\]/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return stripped || prompt.trim();
  }

  private summarizeContextLine(text: string, maxChars: number = 200): string {
    const compact = this.stripMudcodeControlBlocks(text).replace(/\s+/g, ' ').trim();
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(40, maxChars))}...`;
  }

  private summarizeOrchestratorPromptForWorker(prompt: string, maxChars?: number): string {
    const compact = this.stripMudcodeControlBlocks(prompt).trim();
    const resolvedMax = Math.max(
      400,
      maxChars ?? this.resolveOrchestratorPlannerPromptMaxChars(),
    );
    if (compact.length <= resolvedMax) return compact;
    return `${compact.slice(0, resolvedMax)}\n...[truncated by context budget gate]`;
  }

  private hashShort(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }

  private extractPlannerFileHints(prompt: string): string[] {
    const matches = prompt.match(/\b(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g) || [];
    const unique = [...new Set(matches.map((entry) => entry.trim()))];
    return unique.slice(0, 8);
  }

  private buildOrchestratorRollingSummary(
    projectName: string,
    supervisorInstanceId: string,
    latestPrompt: string,
  ): string[] {
    const maxItems = this.resolveOrchestratorRollingSummaryMaxItems();
    const maxChars = this.resolveOrchestratorRollingSummaryMaxChars();
    const prefix = `${projectName}:`;
    const seen = new Set<string>();
    const lines: string[] = [];

    const latestLine = `latest(${supervisorInstanceId}): ${this.summarizeContextLine(latestPrompt, 220)}`;
    lines.push(latestLine);
    seen.add(latestLine);

    const entries = Array.from(this.lastPromptByInstance.entries()).reverse();
    for (const [key, remembered] of entries) {
      if (!key.startsWith(prefix)) continue;
      const instanceId = key.slice(prefix.length) || 'unknown';
      const line = `${instanceId}: ${this.summarizeContextLine(remembered, 180)}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= maxItems) break;
    }

    const bounded: string[] = [];
    let used = 0;
    for (const line of lines) {
      const next = used + line.length;
      if (bounded.length > 0 && next > maxChars) break;
      bounded.push(line);
      used = next + 1;
    }
    return bounded;
  }

  private buildOrchestratorTaskPacketPrompt(params: OrchestratorTaskPacketParams): string {
    const strippedPrompt = this.stripMudcodeControlBlocks(params.prompt);
    const budgetChars = this.resolveOrchestratorContextBudgetChars();
    const plannerMax = this.resolveOrchestratorPlannerPromptMaxChars();
    const excerptBudget = Math.max(400, Math.min(plannerMax, budgetChars - 1000));
    const requestExcerpt = this.summarizeOrchestratorPromptForWorker(strippedPrompt, excerptBudget);
    const originalChars = strippedPrompt.length;
    const truncated = requestExcerpt.length < strippedPrompt.length;
    const overflowChars = truncated ? Math.max(0, originalChars - requestExcerpt.length) : 0;
    const requestLines = strippedPrompt
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const bulletCount = requestLines.filter((line) => /^([-*+]|(\d+[\.)]))\s+/.test(line)).length;
    const rollingSummary = this.buildOrchestratorRollingSummary(
      params.projectName,
      params.supervisorInstanceId,
      strippedPrompt,
    );
    const fileHints = this.extractPlannerFileHints(strippedPrompt);

    return [
      '[mudcode orchestrator-plan]',
      `Task packet: v1 (${this.hashShort(`${params.projectName}:${params.workerInstanceId}:${params.task}:${strippedPrompt}`)})`,
      `project=${params.projectName}`,
      `supervisor=${params.supervisorInstanceId}`,
      `worker=${params.workerInstanceId}`,
      '',
      '[objective]',
      params.task,
      '[/objective]',
      '',
      '[request-summary]',
      requestExcerpt,
      '[/request-summary]',
      '',
      '[rolling-summary]',
      ...rollingSummary.map((line) => `- ${line}`),
      '[/rolling-summary]',
      '',
      '[signals]',
      `continuation=${this.isCodexContinuationPrompt(strippedPrompt)}`,
      `large_context=${this.isLargeContextPrompt(strippedPrompt)}`,
      `lines=${requestLines.length}`,
      `bullets=${bulletCount}`,
      `original_chars=${originalChars}`,
      `budget_chars=${budgetChars}`,
      `truncated=${truncated}`,
      `overflow_chars=${overflowChars}`,
      '[/signals]',
      '',
      '[context-hints]',
      '- Use state artifacts and local files first; do not replay full chat history.',
      '- Prefer diff-only scope discovery (`git diff --name-only`, touched files only).',
      '- Treat progress/events as metadata; exclude them from worker context payloads.',
      ...(fileHints.length > 0
        ? ['- Mentioned files:', ...fileHints.map((path) => `  - ${path}`)]
        : ['- Mentioned files: (none)']),
      '[/context-hints]',
      '',
      'Execution constraints:',
      '- Focus only on this task scope and report concrete diffs/tests.',
      '- If blocked, include exact blocker and attempted checks.',
      '- Do not rewrite whole codebase context unless strictly needed.',
      '[/mudcode orchestrator-plan]',
    ].join('\n');
  }

  private writeOrchestratorTaskPacketArtifact(params: {
    projectPath: string;
    workerInstanceId: string;
    packetContent: string;
  }): string | undefined {
    if (!this.resolveOrchestratorPacketArtifactEnabled()) return undefined;
    if (!params.projectPath || params.projectPath.trim().length === 0) return undefined;

    try {
      const dir = join(params.projectPath, '.mudcode', 'orchestrator', 'packets');
      mkdirSync(dir, { recursive: true });
      const workerSuffix = this.sanitizePacketFileComponent(params.workerInstanceId);
      const fileName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${workerSuffix}.md`;
      const fullPath = join(dir, fileName);
      writeFileSync(fullPath, `${params.packetContent.trimEnd()}\n`, 'utf8');
      return this.normalizeArtifactPathForPrompt(relative(params.projectPath, fullPath));
    } catch {
      return undefined;
    }
  }

  private sanitizePacketFileComponent(raw: string): string {
    const sanitized = String(raw || '')
      .replace(/[\/\\\s]+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!sanitized) return 'worker';
    return sanitized.slice(0, 64);
  }

  private normalizeArtifactPathForPrompt(path: string): string {
    return path.split('\\').join('/');
  }

  private maybeExternalizeOrchestratorTaskPacket(params: {
    projectPath: string;
    workerInstanceId: string;
    task: string;
    packetContent: string;
  }): { prompt: string; packetArtifactPath?: string } {
    const inlineLimit = this.resolveOrchestratorPacketInlineMaxChars();
    if (params.packetContent.length <= inlineLimit) {
      return { prompt: params.packetContent };
    }

    const packetArtifactPath = this.writeOrchestratorTaskPacketArtifact({
      projectPath: params.projectPath,
      workerInstanceId: params.workerInstanceId,
      packetContent: params.packetContent,
    });
    if (!packetArtifactPath) {
      return { prompt: params.packetContent };
    }

    const wrapper = [
      '[mudcode orchestrator-plan]',
      `Task packet file: ${packetArtifactPath}`,
      `packet_digest=${this.hashShort(params.packetContent)}`,
      `objective=${this.summarizeContextLine(params.task, 220)}`,
      'Read the task packet file first, execute only that scope, and avoid loading full chat history.',
      'Return concise changes + verification only.',
      '[/mudcode orchestrator-plan]',
    ].join('\n');
    return { prompt: wrapper, packetArtifactPath };
  }

  private buildOrchestratorDelegationContractPrompt(params: {
    projectName: string;
    supervisorInstanceId: string;
    workerInstanceId: string;
    prompt: string;
  }): string {
    const workerTask = this.stripMudcodeControlBlocks(params.prompt);
    return [
      '[mudcode delegation-contract]',
      `contract=v1`,
      `project=${params.projectName}`,
      `supervisor=${params.supervisorInstanceId}`,
      `worker=${params.workerInstanceId}`,
      '',
      '[worker-task]',
      workerTask,
      '[/worker-task]',
      '',
      'Execution contract:',
      '- Execute only worker-task scope.',
      '- Return concise final format only:',
      '  1) Need your check (manual actions only, or "none")',
      '  2) Changes (file/behavior deltas only)',
      '  3) Verification (commands run + pass/fail)',
      '- Do not include full process logs or hidden chain-of-thought.',
      '[/mudcode delegation-contract]',
    ].join('\n');
  }

  private applyOrchestratorDelegationContract(params: {
    projectName: string;
    supervisorInstanceId: string;
    workerInstanceId: string;
    prompt: string;
  }): { prompt: string; enforced: boolean; warned: boolean } {
    if (params.prompt.trim().length === 0) {
      return { prompt: params.prompt, enforced: false, warned: false };
    }
    if (this.isOrchestratorDelegationContractPrompt(params.prompt)) {
      return { prompt: params.prompt, enforced: false, warned: false };
    }
    const mode = this.resolveOrchestratorDelegationContractMode();
    if (mode === 'off') {
      return { prompt: params.prompt, enforced: false, warned: false };
    }
    if (mode === 'warn') {
      return { prompt: params.prompt, enforced: false, warned: true };
    }
    return {
      prompt: this.buildOrchestratorDelegationContractPrompt(params),
      enforced: true,
      warned: false,
    };
  }

  private extractPlannerTaskCandidates(prompt: string): string[] {
    const lines = prompt
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const fromBullets = lines
      .map((line) => line.match(/^([-*+]|(\d+[\.)]))\s+(.+)$/)?.[3]?.trim() || '')
      .filter((line) => line.length >= 8 && line.length <= 220)
      .map((line) => line.replace(/\s+/g, ' ').trim());
    return [...new Set(fromBullets)];
  }

  private buildPlannerTemplateTasks(prompt: string): string[] {
    const tasks: string[] = [];
    if (this.isCodexContinuationPrompt(prompt)) {
      tasks.push('Continue the highest-impact unfinished implementation path and unblock pending work.');
    }
    tasks.push('Map the exact files/functions to touch, constraints, and regression risks.');
    tasks.push('Implement focused code changes for the assigned scope with minimal side effects.');
    tasks.push('Add/update tests and run verification commands for changed behavior.');
    tasks.push('Perform edge-case review and prepare concise merge notes with residual risks.');
    return tasks;
  }

  private buildAutoPlannerAssignments(params: {
    projectName: string;
    projectPath: string;
    supervisorInstanceId: string;
    prompt: string;
    workers: Array<{ instanceId: string }>;
  }): AutoPlannerAssignment[] {
    if (!this.resolveOrchestratorAutoPlannerEnabled()) return [];
    if (params.workers.length < 1) return [];

    const strippedPrompt = this.stripMudcodeControlBlocks(params.prompt);
    const candidates = this.extractPlannerTaskCandidates(strippedPrompt);
    const templates = this.buildPlannerTemplateTasks(strippedPrompt);
    const tasks: string[] = [];
    for (const candidate of candidates) {
      if (tasks.length >= params.workers.length) break;
      tasks.push(candidate);
    }
    for (const template of templates) {
      if (tasks.length >= params.workers.length) break;
      if (tasks.includes(template)) continue;
      tasks.push(template);
    }
    while (tasks.length < params.workers.length) {
      tasks.push(`Support task ${tasks.length + 1}: validate and de-risk the requested change set.`);
    }

    const total = tasks.length;
    return tasks.map((task, index) => {
      const worker = params.workers[index];
      const workerId = worker?.instanceId || `worker-${index + 1}`;
      const plannerTask = `Planner task ${index + 1}/${total}: ${task}`;
      const packetContent = this.buildOrchestratorTaskPacketPrompt({
        projectName: params.projectName,
        projectPath: params.projectPath,
        supervisorInstanceId: params.supervisorInstanceId,
        workerInstanceId: workerId,
        task: plannerTask,
        prompt: strippedPrompt,
      });
      const packetDelivery = this.maybeExternalizeOrchestratorTaskPacket({
        projectPath: params.projectPath,
        workerInstanceId: workerId,
        task: plannerTask,
        packetContent,
      });
      return {
        task,
        prompt: packetDelivery.prompt,
        ...(packetDelivery.packetArtifactPath
          ? { packetArtifactPath: packetDelivery.packetArtifactPath }
          : {}),
      };
    });
  }

  private shouldAutoDispatchToWorker(prompt: string): boolean {
    const mode = this.resolveOrchestratorAutoDispatchMode();
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    const continuation = this.isCodexContinuationPrompt(prompt);
    if (mode === 'continue') return continuation;
    return continuation || this.isLargeContextPrompt(prompt);
  }

  private canPersistProjectState(): boolean {
    const manager = this.deps.stateManager as unknown as {
      setProject?: (project: ReturnType<typeof normalizeProjectState>) => void;
    };
    return typeof manager.setProject === 'function';
  }

  private async maybeAutoCleanupOrchestratorWorkers(params: {
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    currentInstanceId: string;
  }): Promise<{
    project: ReturnType<typeof normalizeProjectState>;
    notices: string[];
  }> {
    const notices: string[] = [];
    let project = params.normalizedProject;
    if (!this.resolveOrchestratorAutoCleanupUnusedWorkers()) {
      return { project, notices };
    }
    if (!this.canPersistProjectState()) {
      return { project, notices };
    }
    if (!this.deps.orchestratorWorkerProvisioner) {
      return { project, notices };
    }

    const orchestrator = project.orchestrator;
    if (!orchestrator?.enabled) {
      return { project, notices };
    }
    const supervisor = orchestrator.supervisorInstanceId;
    if (!supervisor || params.currentInstanceId !== supervisor) {
      return { project, notices };
    }

    const nowMs = Date.now();
    const intervalMs = this.resolveOrchestratorAutoCleanupIntervalMs();
    const lastRunMs = this.lastOrchestratorAutoCleanupAtMsByProject.get(params.projectName) || 0;
    if (nowMs - lastRunMs < intervalMs) {
      return { project, notices };
    }
    this.lastOrchestratorAutoCleanupAtMsByProject.set(params.projectName, nowMs);
    this.pruneOldest(this.lastOrchestratorAutoCleanupAtMsByProject, 256);

    const workerIds = this.resolveOrchestratorWorkerIds(project).filter((workerId) => workerId !== supervisor);
    if (workerIds.length === 0) {
      return { project, notices };
    }

    for (const workerId of workerIds) {
      this.rememberOrchestratorWorkerFirstSeen(params.projectName, workerId, nowMs);
    }

    const idleThresholdMs = this.resolveOrchestratorAutoCleanupIdleMs();
    const maxRemovals = this.resolveOrchestratorAutoCleanupMaxRemovals();
    const removableWorkers: Array<{
      worker: ProjectInstanceState;
      idleAgeMs: number;
      reason: 'idle' | 'never-used';
    }> = [];

    for (const workerId of workerIds) {
      const worker = getProjectInstance(project, workerId);
      if (!worker) continue;
      if (worker.instanceId === worker.agentType) continue;

      const runtime = this.getPendingRuntimeSnapshot(params.projectName, worker.agentType, worker.instanceId);
      if (runtime.pendingDepth > 0) continue;

      const queue = this.getOrchestratorQueueSnapshot(params.projectName, worker.instanceId);
      if (queue.depth > 0) continue;

      const activity = this.getOrchestratorWorkerActivity(params.projectName, worker.instanceId);
      const firstSeenAt = this.getOrchestratorWorkerFirstSeenAt(params.projectName, worker.instanceId);
      const touchTimestamps: number[] = [];
      if (activity) touchTimestamps.push(activity.atMs);
      const terminalAgeMs = runtime.lastTerminalAgeMs;
      const hasTerminalSnapshot =
        typeof terminalAgeMs === 'number' &&
        Number.isFinite(terminalAgeMs) &&
        terminalAgeMs >= 0;
      if (hasTerminalSnapshot) {
        touchTimestamps.push(nowMs - terminalAgeMs);
      }
      if (
        touchTimestamps.length === 0 &&
        typeof firstSeenAt === 'number' &&
        Number.isFinite(firstSeenAt) &&
        firstSeenAt > 0
      ) {
        touchTimestamps.push(firstSeenAt);
      }
      if (touchTimestamps.length === 0) continue;

      const latestTouchAt = Math.max(...touchTimestamps);
      const idleAgeMs = Math.max(0, nowMs - latestTouchAt);
      if (idleAgeMs < idleThresholdMs) continue;

      removableWorkers.push({
        worker,
        idleAgeMs,
        reason: activity || hasTerminalSnapshot ? 'idle' : 'never-used',
      });
    }

    if (removableWorkers.length === 0) {
      return { project, notices };
    }

    removableWorkers.sort((a, b) => b.idleAgeMs - a.idleAgeMs);
    const selected = removableWorkers.slice(0, maxRemovals);
    const removedIds: string[] = [];
    const removalDetails: string[] = [];
    const warnings: string[] = [];

    for (const item of selected) {
      const worker = item.worker;
      const workerId = worker.instanceId;
      this.clearOrchestratorQueueForWorker(params.projectName, workerId);
      this.deps.pendingTracker.clearPendingForInstance(
        params.projectName,
        worker.agentType,
        worker.instanceId,
      );

      const removed = await this.deps.orchestratorWorkerProvisioner.teardownWorker({
        projectName: params.projectName,
        workerInstanceId: workerId,
      });
      if (removed.removed) {
        removedIds.push(workerId);
        removalDetails.push(`\`${workerId}\` (${item.reason}, ${this.formatAge(item.idleAgeMs)})`);
      } else {
        warnings.push(`${workerId}: ${removed.warning || 'remove skipped'}`);
      }
    }

    if (removedIds.length > 0) {
      const latest = this.deps.stateManager.getProject(params.projectName);
      const latestNormalized = normalizeProjectState(latest || project);
      const latestOrchestrator = latestNormalized.orchestrator;
      if (latestOrchestrator?.enabled) {
        project = normalizeProjectState({
          ...latestNormalized,
          orchestrator: {
            ...latestOrchestrator,
            enabled: true,
            supervisorInstanceId: latestOrchestrator.supervisorInstanceId || supervisor,
            workerInstanceIds: (latestOrchestrator.workerInstanceIds || []).filter(
              (instanceId) => !removedIds.includes(instanceId),
            ),
          },
          lastActive: new Date(),
        });
        this.deps.stateManager.setProject(project);
      }
      notices.push(`🧹 Auto worker cleanup removed: ${removalDetails.join(', ')}`);
      console.log(
        `🧹 [${params.projectName}/${supervisor}] auto worker cleanup removed ${removedIds.length} idle worker(s): ${removedIds.join(', ')}`,
      );
    }
    if (warnings.length > 0) {
      notices.push(`⚠️ Auto worker cleanup warnings: ${warnings.join(' | ')}`);
    }
    return { project, notices };
  }

  private maybeAutoEnableOrchestrator(params: {
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    resolvedAgentType: string;
    currentInstanceId: string;
  }): ReturnType<typeof normalizeProjectState> {
    if (params.resolvedAgentType !== 'codex') return params.normalizedProject;
    if (!this.resolveOrchestratorAutoEnable()) return params.normalizedProject;
    if (params.normalizedProject.orchestrator?.enabled) return params.normalizedProject;
    if (!this.canPersistProjectState()) return params.normalizedProject;

    const resolved = this.resolveCodexOrchestratorEnableConfig({
      project: params.normalizedProject,
      currentInstanceId: params.currentInstanceId,
      requestedSupervisorInstanceId: params.currentInstanceId,
      requestedWorkerFinalVisibility: this.resolveOrchestratorAutoVisibility(),
    });
    if ('error' in resolved) return params.normalizedProject;
    if (resolved.workerInstanceIds.length === 0) return params.normalizedProject;

    const nextProject = normalizeProjectState({
      ...params.normalizedProject,
      orchestrator: {
        enabled: true,
        supervisorInstanceId: resolved.supervisorInstanceId,
        workerInstanceIds: resolved.workerInstanceIds,
        workerFinalVisibility: resolved.workerFinalVisibility,
      },
      lastActive: new Date(),
    });
    this.deps.stateManager.setProject(nextProject);
    console.log(
      `🧭 [${params.projectName}/${params.currentInstanceId}] auto-enabled orchestrator (workers=${resolved.workerInstanceIds.length}, visibility=${resolved.workerFinalVisibility})`,
    );
    return nextProject;
  }

  private async maybeAutoPrepareOrchestrator(params: {
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    resolvedAgentType: string;
    currentInstanceId: string;
    prompt: string;
  }): Promise<{
    project: ReturnType<typeof normalizeProjectState>;
    notices: string[];
  }> {
    const notices: string[] = [];
    let project = params.normalizedProject;
    if (params.resolvedAgentType !== 'codex') {
      return { project, notices };
    }
    const cleanup = await this.maybeAutoCleanupOrchestratorWorkers({
      projectName: params.projectName,
      normalizedProject: project,
      currentInstanceId: params.currentInstanceId,
    });
    project = cleanup.project;
    if (cleanup.notices.length > 0) {
      notices.push(...cleanup.notices);
    }
    if (!this.resolveOrchestratorAutoEnable()) {
      return { project, notices };
    }
    if (!this.shouldAutoDispatchToWorker(params.prompt)) {
      return { project, notices };
    }

    let orchestrator = project.orchestrator;
    if (!orchestrator?.enabled) {
      if (!this.canPersistProjectState()) {
        return { project, notices };
      }
      const resolved = this.resolveCodexOrchestratorEnableConfig({
        project,
        currentInstanceId: params.currentInstanceId,
        requestedSupervisorInstanceId: params.currentInstanceId,
        requestedWorkerFinalVisibility: this.resolveOrchestratorAutoVisibility(),
      });
      if ('error' in resolved) {
        return { project, notices };
      }

      project = normalizeProjectState({
        ...project,
        orchestrator: {
          enabled: true,
          supervisorInstanceId: resolved.supervisorInstanceId,
          workerInstanceIds: resolved.workerInstanceIds,
          workerFinalVisibility: resolved.workerFinalVisibility,
        },
        lastActive: new Date(),
      });
      this.deps.stateManager.setProject(project);
      notices.push(
        `🧭 Auto orchestration enabled (supervisor=\`${resolved.supervisorInstanceId}\`, workers=${resolved.workerInstanceIds.length}).`,
      );
      orchestrator = project.orchestrator;
    }

    if (!orchestrator?.enabled) {
      return { project, notices };
    }
    if (orchestrator.supervisorInstanceId && orchestrator.supervisorInstanceId !== params.currentInstanceId) {
      return { project, notices };
    }

    const knownWorkers = this.resolveOrchestratorWorkerIds(project);
    if (knownWorkers.length > 0) {
      return { project, notices };
    }
    if (!this.resolveOrchestratorAutoSpawnEnabled()) {
      return { project, notices };
    }
    if (!this.deps.orchestratorWorkerProvisioner) {
      return { project, notices };
    }

    const autoSpawnCount = this.resolveOrchestratorAutoSpawnWorkers();
    const spawnResult = await this.deps.orchestratorWorkerProvisioner.spawnCodexWorkers({
      projectName: params.projectName,
      count: autoSpawnCount,
    });

    if (spawnResult.created.length === 0) {
      const warning = (spawnResult.warnings || []).filter(Boolean)[0];
      if (warning) {
        notices.push(`⚠️ Auto worker provision skipped: ${warning}`);
      }
      return { project, notices };
    }

    const latest = this.deps.stateManager.getProject(params.projectName);
    const latestNormalized = normalizeProjectState(latest || project);
    const latestOrchestrator = latestNormalized.orchestrator;
    const mergedWorkerIds = [
      ...new Set(
        [
          ...(latestOrchestrator?.workerInstanceIds || []),
          ...spawnResult.created.map((instance) => instance.instanceId),
        ].filter((id) => id && id !== params.currentInstanceId),
      ),
    ];
    const nextProject = normalizeProjectState({
      ...latestNormalized,
      orchestrator: {
        enabled: true,
        supervisorInstanceId: latestOrchestrator?.supervisorInstanceId || params.currentInstanceId,
        workerInstanceIds: mergedWorkerIds,
        workerFinalVisibility: latestOrchestrator?.workerFinalVisibility || this.resolveOrchestratorAutoVisibility(),
      },
      lastActive: new Date(),
    });
    this.deps.stateManager.setProject(nextProject);
    project = nextProject;

    notices.push(
      `🧠 Auto worker provisioned: ${spawnResult.created.map((instance) => `\`${instance.instanceId}\``).join(', ')}`,
    );
    const warnings = (spawnResult.warnings || []).filter(Boolean);
    if (warnings.length > 0) {
      notices.push(`⚠️ Provision warnings: ${warnings.join(' | ')}`);
    }
    return { project, notices };
  }

  private selectOrchestratorWorkersForDispatch(
    projectName: string,
    project: ReturnType<typeof normalizeProjectState>,
    maxWorkers: number,
  ): ProjectInstanceState[] {
    const workers = this.resolveOrchestratorWorkerIds(project)
      .map((workerId) => getProjectInstance(project, workerId))
      .filter((worker): worker is ProjectInstanceState => Boolean(worker));
    if (workers.length === 0) return [];

    const ranked = workers
      .map((worker) => {
        const runtime = this.getPendingRuntimeSnapshot(projectName, worker.agentType, worker.instanceId);
        const queue = this.getOrchestratorQueueSnapshot(projectName, worker.instanceId);
        const priority = this.resolveOrchestratorWorkerPriority(project, worker.instanceId);
        return {
          worker,
          priority,
          score: runtime.pendingDepth + queue.depth,
          queueDepth: queue.depth,
          pendingDepth: runtime.pendingDepth,
        };
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.score !== b.score) return a.score - b.score;
        if (a.queueDepth !== b.queueDepth) return a.queueDepth - b.queueDepth;
        if (a.pendingDepth !== b.pendingDepth) return a.pendingDepth - b.pendingDepth;
        return a.worker.instanceId.localeCompare(b.worker.instanceId);
      });
    return ranked.slice(0, Math.max(1, maxWorkers)).map((entry) => entry.worker);
  }

  private async dispatchOrQueueOrchestratorWorkerTask(params: {
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    supervisorInstanceId: string;
    worker: ProjectInstanceState;
    prompt: string;
    sourceChannelId: string;
    routeHint?: 'reply' | 'thread' | 'memory';
    allowQueueOnImmediateFailure?: boolean;
    priority?: number;
  }): Promise<OrchestratorDispatchOrQueueOutcome> {
    const turnId = this.buildOrchestratorTurnId({
      projectName: params.projectName,
      supervisorInstanceId: params.supervisorInstanceId,
      workerInstanceId: params.worker.instanceId,
    });
    const contracted = this.applyOrchestratorDelegationContract({
      projectName: params.projectName,
      supervisorInstanceId: params.supervisorInstanceId,
      workerInstanceId: params.worker.instanceId,
      prompt: params.prompt,
    });
    const workerPrompt = contracted.prompt;
    if (contracted.warned) {
      console.warn(
        `Orchestrator delegation-contract warning: ${params.projectName}/${params.worker.instanceId} dispatched without contract wrapper (mode=warn).`,
      );
    } else if (contracted.enforced) {
      console.log(`🧱 [${params.projectName}] delegation-contract enforced for worker ${params.worker.instanceId}`);
    }

    const maxConcurrency = this.resolveOrchestratorQosMaxConcurrency(params.normalizedProject);
    const knownWorkers = this.resolveOrchestratorWorkerIds(params.normalizedProject);
    const runtimeByWorker = new Map<string, PendingRuntimeSnapshot>();
    const activeWorkerCount = knownWorkers.reduce((count, candidateId) => {
      const candidate = getProjectInstance(params.normalizedProject, candidateId);
      if (!candidate) return count;
      const snapshot = this.getPendingRuntimeSnapshot(
        params.projectName,
        candidate.agentType,
        candidate.instanceId,
      );
      runtimeByWorker.set(candidate.instanceId, snapshot);
      return snapshot.pendingDepth > 0 ? count + 1 : count;
    }, 0);

    const runtime =
      runtimeByWorker.get(params.worker.instanceId) ||
      this.getPendingRuntimeSnapshot(
        params.projectName,
        params.worker.agentType,
        params.worker.instanceId,
      );
    if (runtime.pendingDepth <= 0 && activeWorkerCount < maxConcurrency) {
      const dispatched = await this.dispatchPromptToInstance({
        projectName: params.projectName,
        normalizedProject: params.normalizedProject,
        instance: params.worker,
        prompt: workerPrompt,
        turnId,
        routeHint: params.routeHint,
        sourceChannelId: params.sourceChannelId,
      });
      if (dispatched.ok) {
        this.rememberPrompt(params.projectName, params.worker.instanceId, workerPrompt);
        this.rememberOrchestratorWorkerActivity({
          projectName: params.projectName,
          workerInstanceId: params.worker.instanceId,
          turnId,
          stage: 'dispatched',
          prompt: workerPrompt,
          queueDepth: this.getOrchestratorQueueSnapshot(params.projectName, params.worker.instanceId).depth,
        });
        return {
          kind: 'dispatched',
          turnId,
        };
      }

      if (!params.allowQueueOnImmediateFailure) {
        return {
          kind: 'dispatch-failed',
          turnId,
          errorMessage: dispatched.errorMessage,
        };
      }

      const enqueued = this.enqueueOrchestratorTask({
        taskId: `${turnId}:retry`,
        projectName: params.projectName,
        supervisorInstanceId: params.supervisorInstanceId,
        workerInstanceId: params.worker.instanceId,
        prompt: workerPrompt,
        sourceChannelId: params.sourceChannelId,
        routeHint: params.routeHint,
        turnId,
        queuedAtMs: Date.now(),
        attempts: 1,
        nextAttemptAtMs: Date.now() + this.resolveOrchestratorQueueRetryBackoffMs(),
        priority: this.resolveOrchestratorWorkerPriority(
          params.normalizedProject,
          params.worker.instanceId,
          params.priority,
        ),
      });
      if (!enqueued.ok) {
        return {
          kind: 'dispatch-failed',
          turnId,
          errorMessage: dispatched.errorMessage,
        };
      }
      this.scheduleOrchestratorQueueDrain(params.projectName, params.worker.instanceId);
      this.rememberPrompt(params.projectName, params.worker.instanceId, workerPrompt);
      this.rememberOrchestratorWorkerActivity({
        projectName: params.projectName,
        workerInstanceId: params.worker.instanceId,
        turnId,
        stage: 'retry-queued',
        prompt: workerPrompt,
        queueDepth: enqueued.queueDepth,
      });
      return {
        kind: 'queued',
        turnId,
        queueDepth: enqueued.queueDepth,
        queuePosition: enqueued.position,
        immediateFailureQueued: true,
      };
    }

    const enqueued = this.enqueueOrchestratorTask({
      taskId: `${turnId}:queued`,
      projectName: params.projectName,
      supervisorInstanceId: params.supervisorInstanceId,
      workerInstanceId: params.worker.instanceId,
      prompt: workerPrompt,
      sourceChannelId: params.sourceChannelId,
      routeHint: params.routeHint,
      turnId,
      queuedAtMs: Date.now(),
      attempts: 0,
      priority: this.resolveOrchestratorWorkerPriority(
        params.normalizedProject,
        params.worker.instanceId,
        params.priority,
      ),
    });
    if (!enqueued.ok) {
      return {
        kind: 'queue-full',
        turnId,
      };
    }
    this.scheduleOrchestratorQueueDrain(params.projectName, params.worker.instanceId);
    this.rememberPrompt(params.projectName, params.worker.instanceId, workerPrompt);
    this.rememberOrchestratorWorkerActivity({
      projectName: params.projectName,
      workerInstanceId: params.worker.instanceId,
      turnId,
      stage: 'queued',
      prompt: workerPrompt,
      queueDepth: enqueued.queueDepth,
    });
    return {
      kind: 'queued',
      turnId,
      queueDepth: enqueued.queueDepth,
      queuePosition: enqueued.position,
    };
  }

  private async dispatchPromptToInstance(params: {
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    instance: ProjectInstanceState;
    prompt: string;
    turnId: string;
    routeHint?: 'reply' | 'thread' | 'memory';
    sourceChannelId: string;
  }): Promise<{ ok: true } | { ok: false; restarted?: true; errorMessage?: string }> {
    const instance = params.instance;
    const windowName = instance.tmuxWindow || instance.instanceId;
    const targetChannelId = instance.channelId || params.sourceChannelId;

    await this.safePendingUpdate('orchestrator:markPending', () =>
      this.deps.pendingTracker.markPending(
        params.projectName,
        instance.agentType,
        targetChannelId,
        params.turnId,
        instance.instanceId,
        params.prompt,
      ),
    );
    await this.safePendingUpdate('orchestrator:markRouteResolved', () =>
      this.deps.pendingTracker.markRouteResolved(
        params.projectName,
        instance.agentType,
        instance.instanceId,
        params.routeHint || 'memory',
      ),
    );
    await this.safePendingUpdate('orchestrator:markDispatching', () =>
      this.deps.pendingTracker.markDispatching(
        params.projectName,
        instance.agentType,
        instance.instanceId,
      ),
    );

    try {
      if (instance.agentType === 'codex') {
        const codexResult = await this.submitToCodex(
          params.normalizedProject.tmuxSession,
          windowName,
          params.prompt,
        );
        if (codexResult === 'restarted') {
          await this.safePendingUpdate('orchestrator:markRetry', () =>
            this.deps.pendingTracker.markRetry(params.projectName, instance.agentType, instance.instanceId, 'tail'),
          );
          return { ok: false, restarted: true };
        }
        this.deps.ioTracker?.recordPromptSubmitted({
          projectName: params.projectName,
          instanceId: instance.instanceId,
          channelId: targetChannelId,
          projectPath: params.normalizedProject.projectPath,
          prompt: params.prompt,
        });
        void this.safeEmitCodexStartEvent({
          projectName: params.projectName,
          instanceId: instance.instanceId,
          turnId: params.turnId,
          channelId: targetChannelId,
        });
        return { ok: true };
      }

      if (instance.agentType === 'opencode') {
        await this.submitToOpencode(params.normalizedProject.tmuxSession, windowName, params.prompt);
      } else {
        this.deps.tmux.sendKeysToWindow(
          params.normalizedProject.tmuxSession,
          windowName,
          params.prompt,
          instance.agentType,
        );
      }
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (instance.agentType === 'codex') {
        this.deps.ioTracker?.recordTurnFailed({
          projectName: params.projectName,
          instanceId: instance.instanceId,
          channelId: targetChannelId,
          reason: errorMessage,
        });
        void this.safeEmitCodexErrorEvent({
          projectName: params.projectName,
          instanceId: instance.instanceId,
          turnId: params.turnId,
          channelId: targetChannelId,
          text: errorMessage,
        });
      }
      await this.safePendingUpdate('orchestrator:markError', () =>
        this.deps.pendingTracker.markError(params.projectName, instance.agentType, instance.instanceId, 'tail'),
      );
      return { ok: false, errorMessage };
    }
  }

  private resolveSnapshotTailLines(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_SNAPSHOT_TAIL_LINES || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 500) {
      return Math.trunc(fromEnv);
    }
    return 30;
  }

  private resolveSnapshotCaptureHistoryLines(tailLines: number): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_SNAPSHOT_CAPTURE_HISTORY_LINES || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 5000) {
      return Math.max(tailLines, Math.trunc(fromEnv));
    }
    return Math.max(tailLines, 120);
  }

  private shouldUseSnapshotThreadDelivery(payload: string): boolean {
    if (this.deps.messaging.platform !== 'discord') return false;
    if (typeof this.deps.messaging.sendLongOutput !== 'function') return false;
    const fromEnv = Number(process.env.AGENT_DISCORD_SNAPSHOT_LONG_OUTPUT_THREAD_THRESHOLD || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1200 && fromEnv <= 20000) {
      return payload.length >= Math.trunc(fromEnv);
    }
    return payload.length >= 1800;
  }

  private getPendingDepth(projectName: string, agentType: string, instanceId?: string): number {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getPendingDepth?: (projectName: string, agentType: string, instanceId?: string) => number;
    };
    return typeof pendingTracker.getPendingDepth === 'function'
      ? pendingTracker.getPendingDepth(projectName, agentType, instanceId)
      : 0;
  }

  private getPendingRuntimeSnapshot(
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
    return { pendingDepth: this.getPendingDepth(projectName, agentType, instanceId) };
  }

  private formatAge(ageMs?: number): string {
    if (!Number.isFinite(ageMs) || typeof ageMs !== 'number' || ageMs < 0) return 'unknown';
    if (ageMs < 1000) return '<1s';
    const sec = Math.round(ageMs / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    const hours = Math.round(min / 60);
    return `${hours}h`;
  }

  private hasEscToInterruptMarker(captureRaw: string): boolean {
    const lines = cleanCapture(captureRaw)
      .split('\n')
      .map((line) => line.toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);
    const tail = lines.slice(-20);
    return tail.some((line) => {
      if (line === 'esc to interrupt') return true;
      if (line.includes('for shortcuts') && line.includes('esc to interrupt')) return true;
      if (line.startsWith('esc to interrupt ') && line.length <= 48) return true;
      return false;
    });
  }

  private detectPaneWorkingHint(sessionName: string, windowName: string, agentType: string): boolean {
    if (agentType !== 'codex') return false;
    try {
      const pane = this.deps.tmux.capturePaneFromWindow(sessionName, windowName, agentType);
      return this.hasEscToInterruptMarker(pane);
    } catch {
      return false;
    }
  }

  private normalizeCaptureLine(line: string): string {
    return line.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private normalizePromptTail(prompt: string): string[] {
    const normalized = prompt.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.length < 24) return [];
    const tails = [160, 120, 80, 48]
      .filter((size) => normalized.length >= size)
      .map((size) => normalized.slice(-size));
    return [...new Set([normalized, ...tails])];
  }

  private hasExplicitSubAgentRequest(prompt: string): boolean {
    if (/\[mudcode auto-subagent\]/i.test(prompt)) return true;
    if (/\bsub[-\s]?agent\b/i.test(prompt)) return true;
    if (/\bspawn[_-]?agent\b/i.test(prompt)) return true;
    if (/\bparallel(?:ize)?\b/i.test(prompt)) return true;
    if (/서브\s*에이전트/i.test(prompt)) return true;
    if (/작업\s*분할/i.test(prompt)) return true;
    if (/나눠(?:서)?\s*진행/i.test(prompt)) return true;
    if (/병렬\s*처리/i.test(prompt)) return true;
    return false;
  }

  private isLargeContextPrompt(prompt: string): boolean {
    const minChars = Math.max(600, this.getEnvInt('AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_CHARS', 2600));
    const minLines = Math.max(8, this.getEnvInt('AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_LINES', 48));
    const minBulletLines = Math.max(3, this.getEnvInt('AGENT_DISCORD_CODEX_AUTO_SUBAGENT_MIN_BULLETS', 8));

    const lines = prompt
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const bulletLines = lines.filter((line) => /^([-*+]|(\d+[\.)]))\s+/.test(line)).length;
    const fenceCount = (prompt.match(/```/g) || []).length;

    if (prompt.length >= minChars) return true;
    if (lines.length >= minLines && bulletLines >= minBulletLines) return true;
    if (lines.length >= Math.floor(minLines * 1.5)) return true;
    if (fenceCount >= 2 && prompt.length >= Math.floor(minChars * 0.7)) return true;
    return false;
  }

  private resolveCodexAutoSubagentThreadCap(): number {
    const value = this.getEnvInt('AGENT_DISCORD_CODEX_AUTO_SUBAGENT_THREAD_CAP', 6);
    return Math.min(32, Math.max(1, value));
  }

  private maybeAugmentCodexPromptForSubAgent(prompt: string): { prompt: string; applied: boolean } {
    if (!this.getEnvBool('AGENT_DISCORD_CODEX_AUTO_SUBAGENT', true)) {
      return { prompt, applied: false };
    }
    if (prompt.trim().length === 0) return { prompt, applied: false };
    if (this.hasExplicitSubAgentRequest(prompt)) return { prompt, applied: false };
    if (!this.isLargeContextPrompt(prompt)) return { prompt, applied: false };

    const threadCap = this.resolveCodexAutoSubagentThreadCap();
    const hint = [
      '[mudcode auto-subagent]',
      'This request looks context-heavy. Split work and run focused sub-agent Codex workers.',
      '- Create 2-4 sub-agents with explicit ownership (files/responsibility).',
      `- Respect runtime sub-agent thread cap: keep active spawn_agent workers <= ${threadCap}.`,
      '- Run independent chunks in parallel, then merge and verify once.',
      '- If thread limit is reached, do not stop. Reuse existing workers or continue sequentially.',
      '- Keep each sub-agent context narrow; avoid full-repo rereads unless needed.',
      '- Return one integrated summary with changed files and verification results.',
      '[/mudcode auto-subagent]',
    ].join('\n');

    const augmented = `${prompt.trimEnd()}\n\n${hint}`;
    return { prompt: augmented, applied: true };
  }

  private resolveCodexLongTaskReportMode(): CodexLongTaskReportMode {
    const raw = (process.env.AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'continue' || raw === 'auto' || raw === 'always') {
      return raw;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) return 'auto';
    if (['0', 'false', 'no'].includes(raw)) return 'off';
    return 'continue';
  }

  private resolveCodexLanguagePolicyMode(): CodexLanguagePolicyMode {
    const raw = (process.env.AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE || '').trim().toLowerCase();
    if (raw === 'off' || raw === 'korean' || raw === 'always') return raw;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return 'korean';
    if (['0', 'false', 'no'].includes(raw)) return 'off';
    return 'off';
  }

  private hasKoreanCharacters(text: string): boolean {
    return /[\u3131-\u318E\uAC00-\uD7A3]/.test(text);
  }

  private isCodexContinuationPrompt(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (/^continue(?:\s|$)/.test(normalized)) return true;
    if (/^go on(?:\s|$)/.test(normalized)) return true;
    if (/^keep going(?:\s|$)/.test(normalized)) return true;
    if (/^계속(?:\s|$)/.test(normalized)) return true;
    if (/^계속해(?:\s|$)/.test(normalized)) return true;
    if (/^계속 진행(?:\s|$)/.test(normalized)) return true;
    if (/^쭉(?:\s|$)/.test(normalized)) return true;
    if (/^진행(?:\s|$)/.test(normalized)) return true;
    return false;
  }

  private maybeAugmentCodexPromptForLongTaskReport(prompt: string): { prompt: string; applied: boolean } {
    if (prompt.trim().length === 0) return { prompt, applied: false };
    if (/\[mudcode longtask-report\]/i.test(prompt)) return { prompt, applied: false };

    const mode = this.resolveCodexLongTaskReportMode();
    if (mode === 'off') return { prompt, applied: false };

    const continuationPrompt = this.isCodexContinuationPrompt(prompt);
    const largeContextPrompt = this.isLargeContextPrompt(prompt);
    const shouldApply =
      mode === 'always' ||
      (mode === 'auto' && (continuationPrompt || largeContextPrompt)) ||
      (mode === 'continue' && continuationPrompt);
    if (!shouldApply) return { prompt, applied: false };

    const hint = [
      '[mudcode longtask-report]',
      'Execution policy for long tasks:',
      '- Keep going autonomously until done or a hard blocker appears.',
      '- Do not ask for intermediate confirmation unless a manual decision/check is required.',
      '- Final response should be concise and include only:',
      '  1) Need your check (manual actions only, or "none")',
      '  2) Changes (file/behavior deltas only)',
      '  3) Verification (commands run + pass/fail)',
      '[/mudcode longtask-report]',
    ].join('\n');

    const augmented = `${prompt.trimEnd()}\n\n${hint}`;
    return { prompt: augmented, applied: true };
  }

  private maybeAugmentCodexPromptForLanguagePolicy(prompt: string): { prompt: string; applied: boolean } {
    if (prompt.trim().length === 0) return { prompt, applied: false };
    if (/\[mudcode language-policy\]/i.test(prompt)) return { prompt, applied: false };

    const mode = this.resolveCodexLanguagePolicyMode();
    if (mode === 'off') return { prompt, applied: false };
    if (mode === 'korean' && !this.hasKoreanCharacters(prompt)) {
      return { prompt, applied: false };
    }

    const hint = [
      '[mudcode language-policy]',
      'Language execution policy:',
      '- Reason and plan internally in English for coding/tool operations.',
      '- Keep code, commands, and technical identifiers in their natural language form.',
      '- Write the final user-facing response in the user\'s language unless explicitly requested otherwise.',
      '[/mudcode language-policy]',
    ].join('\n');

    const augmented = `${prompt.trimEnd()}\n\n${hint}`;
    return { prompt: augmented, applied: true };
  }

  private maybeAugmentCodexPromptForSupervisorOrchestrationGuard(params: {
    prompt: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    supervisorInstanceId: string;
  }): { prompt: string; applied: boolean } {
    if (!this.getEnvBool('AGENT_DISCORD_ORCHESTRATOR_SUPERVISOR_GUARD', true)) {
      return { prompt: params.prompt, applied: false };
    }
    if (params.prompt.trim().length === 0) return { prompt: params.prompt, applied: false };
    if (/\[mudcode supervisor-orchestrator-guard\]/i.test(params.prompt)) {
      return { prompt: params.prompt, applied: false };
    }

    const orchestrator = params.normalizedProject.orchestrator;
    if (!orchestrator?.enabled) return { prompt: params.prompt, applied: false };
    if (!orchestrator.supervisorInstanceId || orchestrator.supervisorInstanceId !== params.supervisorInstanceId) {
      return { prompt: params.prompt, applied: false };
    }
    const workers = this.resolveOrchestratorWorkerIds(params.normalizedProject).filter(
      (instanceId) => instanceId !== params.supervisorInstanceId,
    );
    if (workers.length === 0) return { prompt: params.prompt, applied: false };

    const hint = [
      '[mudcode supervisor-orchestrator-guard]',
      'You are the supervisor in orchestrator mode.',
      '- Do not directly implement code before delegating focused tasks to workers.',
      '- Assign scoped work to worker instances first, then integrate their results.',
      '- If sub-agent thread capacity is unavailable, keep going with existing workers or sequential delegation.',
      '- Keep final response concise: Need your check / Changes / Verification.',
      '[/mudcode supervisor-orchestrator-guard]',
    ].join('\n');
    return {
      prompt: `${params.prompt.trimEnd()}\n\n${hint}`,
      applied: true,
    };
  }

  private shouldRetryCodexSubmit(sessionName: string, windowName: string, prompt: string): boolean {
    try {
      const captureRaw = this.deps.tmux.capturePaneFromWindow(sessionName, windowName, 'codex');
      if (this.hasEscToInterruptMarker(captureRaw)) return false;

      const cleaned = cleanCapture(captureRaw);
      if (!cleaned || cleaned.trim().length === 0) return true;

      const tailLines = cleaned
        .split('\n')
        .map((line) => this.normalizeCaptureLine(line))
        .filter((line) => line.length > 0)
        .slice(-24);

      const tailJoined = tailLines.join('\n');
      const promptTails = this.normalizePromptTail(prompt);
      if (promptTails.some((tail) => tailJoined.includes(tail))) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private buildInputStatus(snapshot: PendingRuntimeSnapshot, paneWorkingHint: boolean): string {
    if (snapshot.pendingDepth > 0) {
      const latestStage = snapshot.latestStage || snapshot.oldestStage || 'received';
      return `✅ accepted (\`${snapshot.pendingDepth}\` queued, latest stage: \`${latestStage}\`)`;
    }
    if (paneWorkingHint) {
      return '⚠️ tracker queue is empty, but pane still shows working (`Esc to interrupt`)';
    }
    if (snapshot.lastTerminalStage === 'completed') {
      return `✅ completed recently (${this.formatAge(snapshot.lastTerminalAgeMs)} ago)`;
    }
    if (snapshot.lastTerminalStage === 'error') {
      return `⚠️ last request failed (${this.formatAge(snapshot.lastTerminalAgeMs)} ago)`;
    }
    if (snapshot.lastTerminalStage === 'retry') {
      return `⚠️ last request needs retry (${this.formatAge(snapshot.lastTerminalAgeMs)} ago)`;
    }
    return 'ℹ️ no in-flight request';
  }

  private buildRuntimeStatus(snapshot: PendingRuntimeSnapshot, paneWorkingHint: boolean): string {
    if (paneWorkingHint) return '🟡 working (pane shows `Esc to interrupt`)';
    if (snapshot.pendingDepth <= 0) return '🟢 idle';

    const stage = snapshot.oldestStage || snapshot.latestStage || 'received';
    if (stage === 'processing') {
      return `🟡 working (oldest stage: \`${stage}\`, age: ${this.formatAge(snapshot.oldestAgeMs)})`;
    }
    if (stage === 'routed') {
      return `🟡 routed to tmux (age: ${this.formatAge(snapshot.oldestAgeMs)})`;
    }
    return `🟡 queued (stage: \`${stage}\`, age: ${this.formatAge(snapshot.oldestAgeMs)})`;
  }

  private async sendHealthSummary(params: {
    channelId: string;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    resolvedAgentType: string;
    instanceId: string;
    windowName: string;
  }): Promise<void> {
    const sessionName = params.normalizedProject.tmuxSession;
    const sessionAlive = this.deps.tmux.sessionExistsFull(sessionName);
    const windowAlive = sessionAlive && this.deps.tmux.windowExists(sessionName, params.windowName);
    const paneWorkingHint =
      windowAlive && this.detectPaneWorkingHint(sessionName, params.windowName, params.resolvedAgentType);
    const runtimeSnapshot = this.getPendingRuntimeSnapshot(
      params.projectName,
      params.resolvedAgentType,
      params.instanceId,
    );
    const daemonStatus = await getDaemonStatus().catch(() => undefined);

    const lines = [
      '🩺 **Mudcode Health**',
      `Project: \`${params.projectName}\``,
      `Instance: \`${params.instanceId}\` (\`${params.resolvedAgentType}\`)`,
      `tmux session: \`${sessionName}\` ${sessionAlive ? '✅' : '⚠️ missing'}`,
      `tmux window: \`${params.windowName}\` ${windowAlive ? '✅' : '⚠️ missing'}`,
      `input status: ${this.buildInputStatus(runtimeSnapshot, paneWorkingHint)}`,
      `runtime status: ${this.buildRuntimeStatus(runtimeSnapshot, paneWorkingHint)}`,
      `pending queue: \`${runtimeSnapshot.pendingDepth}\``,
    ];

    if (daemonStatus) {
      lines.push(`daemon: ${daemonStatus.running ? `✅ running on ${daemonStatus.port}` : `⚠️ not running (expected ${daemonStatus.port})`}`);
    }

    await this.deps.messaging.sendToChannel(params.channelId, lines.join('\n'));
  }

  private async sendSnapshot(params: {
    channelId: string;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    resolvedAgentType: string;
    instanceId: string;
    windowName: string;
  }): Promise<void> {
    try {
      const tailLineLimit = this.resolveSnapshotTailLines();
      const captureHistoryLines = this.resolveSnapshotCaptureHistoryLines(tailLineLimit);
      const pane = this.deps.tmux.capturePaneFromWindow(
        params.normalizedProject.tmuxSession,
        params.windowName,
        params.resolvedAgentType,
        captureHistoryLines,
      );
      const snapshot = cleanCapture(pane);
      if (!snapshot || snapshot.trim().length === 0) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Snapshot is empty for \`${params.projectName}/${params.instanceId}\`.`,
        );
        return;
      }

      const lines = snapshot.split('\n');
      const tailLines = lines.slice(-tailLineLimit);
      const title =
        tailLines.length < lines.length
          ? `📸 Snapshot \`${params.projectName}/${params.instanceId}\` (last ${tailLines.length}/${lines.length} lines)`
          : `📸 Snapshot \`${params.projectName}/${params.instanceId}\``;
      const payload = `${title}\n\`\`\`text\n${tailLines.join('\n')}\n\`\`\``;
      if (this.shouldUseSnapshotThreadDelivery(payload)) {
        await this.deps.messaging.sendLongOutput!(params.channelId, payload);
      } else {
        await this.deps.messaging.sendToChannel(params.channelId, payload);
      }
    } catch (error) {
      await this.deps.messaging.sendToChannel(params.channelId, this.buildDeliveryFailureGuidance(params.projectName, error));
    }
  }

  private async sendOrchestratorWorkerInfo(params: {
    channelId: string;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    worker: ProjectInstanceState;
    workerInstanceId: string;
  }): Promise<void> {
    const workerWindow = params.worker.tmuxWindow || params.worker.instanceId;
    const sessionName = params.normalizedProject.tmuxSession;
    const sessionAlive = this.deps.tmux.sessionExistsFull(sessionName);
    const windowAlive = sessionAlive && this.deps.tmux.windowExists(sessionName, workerWindow);
    const paneWorkingHint = windowAlive && this.detectPaneWorkingHint(sessionName, workerWindow, params.worker.agentType);
    const runtime = this.getPendingRuntimeSnapshot(
      params.projectName,
      params.worker.agentType,
      params.worker.instanceId,
    );
    const queue = this.getOrchestratorQueueSnapshot(params.projectName, params.workerInstanceId);
    const activity = this.getOrchestratorWorkerActivity(params.projectName, params.workerInstanceId);
    const queueHead = this.buildWorkerQueueHeadSummary(params.projectName, params.workerInstanceId, 140);

    const lines = [
      `🧩 Subagent \`${params.workerInstanceId}\``,
      `agent: \`${params.worker.agentType}\``,
      `channel: \`${params.worker.channelId || '(none)'}\``,
      `tmux session: \`${sessionName}\` ${sessionAlive ? '✅' : '⚠️ missing'}`,
      `tmux window: \`${workerWindow}\` ${windowAlive ? '✅' : '⚠️ missing'}`,
      `runtime status: ${this.buildRuntimeStatus(runtime, paneWorkingHint)}`,
      `pending queue: \`${runtime.pendingDepth}\``,
      `orchestrator queue: \`${queue.depth}\`${queue.oldestAgeMs !== undefined ? ` (oldest ${this.formatAge(queue.oldestAgeMs)})` : ''}`,
      activity
        ? `recent orchestrator task: ${this.formatWorkerActivityStage(activity.stage)} ${this.formatAge(Date.now() - activity.atMs)} ago (turn \`${activity.turnId}\`)`
        : 'recent orchestrator task: (none)',
      activity ? `recent task summary: ${activity.promptSummary}` : 'recent task summary: (none)',
      queueHead ? `queue head: ${queueHead}` : 'queue head: (none)',
      `event hook: \`${params.worker.eventHook ? 'on' : 'off'}\``,
    ];
    await this.deps.messaging.sendToChannel(params.channelId, lines.join('\n'));
  }

  private async sendOrchestratorWorkerLog(params: {
    channelId: string;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    worker: ProjectInstanceState;
    workerInstanceId: string;
    tailLines?: number;
  }): Promise<void> {
    const workerWindow = params.worker.tmuxWindow || params.worker.instanceId;
    const tailLineLimit = this.resolveSubagentsLogTailLines(params.tailLines);
    const captureHistoryLines = this.resolveSnapshotCaptureHistoryLines(tailLineLimit);
    try {
      const pane = this.deps.tmux.capturePaneFromWindow(
        params.normalizedProject.tmuxSession,
        workerWindow,
        params.worker.agentType,
        captureHistoryLines,
      );
      const snapshot = cleanCapture(pane);
      if (!snapshot || snapshot.trim().length === 0) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Log is empty for \`${params.projectName}/${params.workerInstanceId}\`.`,
        );
        return;
      }
      const lines = snapshot.split('\n');
      const tail = lines.slice(-tailLineLimit);
      const title =
        tail.length < lines.length
          ? `📜 Subagent log \`${params.projectName}/${params.workerInstanceId}\` (last ${tail.length}/${lines.length} lines)`
          : `📜 Subagent log \`${params.projectName}/${params.workerInstanceId}\``;
      const codeblockPayload = `${title}\n\`\`\`text\n${tail.join('\n')}\n\`\`\``;
      if (this.shouldUseSnapshotThreadDelivery(codeblockPayload)) {
        await this.deps.messaging.sendLongOutput!(params.channelId, codeblockPayload);
        return;
      }
      if (codeblockPayload.length <= 1800) {
        await this.deps.messaging.sendToChannel(params.channelId, codeblockPayload);
        return;
      }
      await this.sendSplitMessage(params.channelId, `${title}\n${tail.join('\n')}`);
    } catch (error) {
      await this.deps.messaging.sendToChannel(params.channelId, this.buildDeliveryFailureGuidance(params.projectName, error));
    }
  }

  private async sendSplitMessage(channelId: string, content: string): Promise<void> {
    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    for (const chunk of split(content)) {
      if (chunk.trim().length === 0) continue;
      await this.deps.messaging.sendToChannel(channelId, chunk);
    }
  }

  private formatDoctorSummary(result: DoctorResult): string {
    const warnCount = result.issues.filter((issue) => issue.level === 'warn').length;
    const failCount = result.issues.filter((issue) => issue.level === 'fail').length;
    const contractIssues = result.issues.filter((issue) => issue.code.startsWith('event-contract'));
    const issueLines = result.issues
      .slice(0, 4)
      .map((issue) => `- [${issue.level.toUpperCase()}] ${issue.code}: ${issue.message}`);
    const fixLines = result.fixes
      .slice(0, 4)
      .map((fix) => `- ${fix.code}: ${fix.message}`);
    const contractLines = contractIssues
      .slice(0, 3)
      .map((issue) => `- [${issue.level.toUpperCase()}] ${issue.code}: ${issue.message}`);

    const lines = [
      '🩺 **Mudcode Doctor**',
      `result: ${result.ok ? '✅ ok' : '❌ fail'}${result.fixed ? ' (auto-fixed)' : ''}`,
      `issues: fail=${failCount}, warn=${warnCount}`,
      `contract: ${contractIssues.length > 0 ? `${contractIssues.length} issue(s)` : 'clean'}`,
      `progress modes: off=${result.summary.runtimeProgressModeOff ?? 0}, thread=${result.summary.runtimeProgressModeThread ?? 0}, channel=${result.summary.runtimeProgressModeChannel ?? 0}, unknown=${result.summary.runtimeProgressModeUnknown ?? 0}`,
      `codex channel-mode: ${result.summary.runtimeCodexProgressModeChannel ?? 0}`,
      `effective threshold: \`${result.summary.effectiveThreshold ?? 'unset'}\``,
    ];

    if (contractLines.length > 0) {
      lines.push('');
      lines.push('contract highlights:');
      lines.push(...contractLines);
      if (contractIssues.length > contractLines.length) {
        lines.push(`- ... ${contractIssues.length - contractLines.length} more`);
      }
    }

    if (issueLines.length > 0) {
      lines.push('');
      lines.push('top issues:');
      lines.push(...issueLines);
      if (result.issues.length > issueLines.length) {
        lines.push(`- ... ${result.issues.length - issueLines.length} more`);
      }
    }

    if (fixLines.length > 0) {
      lines.push('');
      lines.push('applied fixes:');
      lines.push(...fixLines);
      if (result.fixes.length > fixLines.length) {
        lines.push(`- ... ${result.fixes.length - fixLines.length} more`);
      }
    }

    return lines.join('\n');
  }

  private resolveMudcodeCliInvocation(args: string[]): { command: string; args: string[] } {
    const execPath = process.execPath || '';
    const execName = execPath.split(/[\\/]/).pop()?.toLowerCase() || '';
    const scriptPath = process.argv[1];

    if (execName === 'mudcode' || execName === 'mudcode.exe') {
      return { command: execPath, args };
    }

    if (
      (execName === 'bun' || execName === 'bun.exe' || execName === 'node' || execName === 'node.exe') &&
      scriptPath
    ) {
      return { command: execPath, args: [scriptPath, ...args] };
    }

    return { command: 'mudcode', args };
  }

  private scheduleBackgroundCli(args: string[], delayMs: number = 0): void {
    if (this.deps.backgroundCliRunner) {
      this.deps.backgroundCliRunner(args, delayMs);
      return;
    }

    const invocation = this.resolveMudcodeCliInvocation(args);
    const run = () => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
    };

    if (delayMs > 0) {
      const timer = setTimeout(run, delayMs);
      timer.unref();
      return;
    }

    run();
  }

  private async handleMaintenanceCommand(params: {
    command: MaintenanceCommand;
    channelId: string;
    projectName: string;
    normalizedProject: ReturnType<typeof normalizeProjectState>;
    routeHint?: 'reply' | 'thread' | 'memory';
    instanceId: string;
  }): Promise<void> {
    if (params.command.kind === 'orchestrator-help') {
      await this.deps.messaging.sendToChannel(params.channelId, params.command.message);
      return;
    }

    if (params.command.kind === 'orchestrator-status') {
      await this.deps.messaging.sendToChannel(
        params.channelId,
        this.buildOrchestratorStatusSummary(params.normalizedProject),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-worker-info' || params.command.kind === 'orchestrator-worker-log') {
      const orchestrator = params.normalizedProject.orchestrator;
      if (!orchestrator?.enabled) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Orchestrator is disabled. Run `/orchestrator enable` first.',
        );
        return;
      }
      const supervisor = orchestrator.supervisorInstanceId;
      if (!supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor is not configured. Re-run `/orchestrator enable <supervisorInstanceId>`.',
        );
        return;
      }
      if (params.instanceId !== supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Only supervisor \`${supervisor}\` can inspect worker instances.`,
        );
        return;
      }

      const resolved = this.resolveWorkerForCommand({
        project: params.normalizedProject,
        workerToken: params.command.workerToken,
      });
      if (!resolved.workerInstanceId || !resolved.worker) {
        await this.deps.messaging.sendToChannel(params.channelId, `⚠️ ${resolved.error || 'worker not found'}`);
        return;
      }

      if (params.command.kind === 'orchestrator-worker-info') {
        await this.sendOrchestratorWorkerInfo({
          channelId: params.channelId,
          projectName: params.projectName,
          normalizedProject: params.normalizedProject,
          worker: resolved.worker,
          workerInstanceId: resolved.workerInstanceId,
        });
        return;
      }

      await this.sendOrchestratorWorkerLog({
        channelId: params.channelId,
        projectName: params.projectName,
        normalizedProject: params.normalizedProject,
        worker: resolved.worker,
        workerInstanceId: resolved.workerInstanceId,
        tailLines: params.command.tailLines,
      });
      return;
    }

    if (params.command.kind === 'orchestrator-enable') {
      this.clearOrchestratorQueueForProject(params.projectName);
      const resolved = this.resolveCodexOrchestratorEnableConfig({
        project: params.normalizedProject,
        currentInstanceId: params.instanceId,
        requestedSupervisorInstanceId: params.command.supervisorInstanceId,
        requestedWorkerFinalVisibility: params.command.workerFinalVisibility,
      });
      if ('error' in resolved) {
        await this.deps.messaging.sendToChannel(params.channelId, `⚠️ ${resolved.error}`);
        return;
      }
      const nextProject = normalizeProjectState({
        ...params.normalizedProject,
        orchestrator: {
          enabled: true,
          supervisorInstanceId: resolved.supervisorInstanceId,
          workerInstanceIds: resolved.workerInstanceIds,
          workerFinalVisibility: resolved.workerFinalVisibility,
        },
        lastActive: new Date(),
      });
      this.deps.stateManager.setProject(nextProject);
      await this.deps.messaging.sendToChannel(
        params.channelId,
        [
          '✅ Orchestrator enabled',
          `supervisor: \`${resolved.supervisorInstanceId}\``,
          `workers: ${resolved.workerInstanceIds.length > 0 ? resolved.workerInstanceIds.map((id) => `\`${id}\``).join(', ') : '(none)'}`,
          `worker final visibility: \`${resolved.workerFinalVisibility}\``,
        ].join('\n'),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-run') {
      const orchestrator = params.normalizedProject.orchestrator;
      if (!orchestrator?.enabled) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Orchestrator is disabled. Run `/orchestrator enable` first.',
        );
        return;
      }
      const supervisor = orchestrator.supervisorInstanceId;
      if (!supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor is not configured. Re-run `/orchestrator enable <supervisorInstanceId>`.',
        );
        return;
      }
      if (params.instanceId !== supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Only supervisor \`${supervisor}\` can dispatch worker tasks.`,
        );
        return;
      }
      const resolved = this.resolveWorkerForCommand({
        project: params.normalizedProject,
        workerToken: params.command.workerInstanceId,
      });
      if (!resolved.workerInstanceId || !resolved.worker) {
        await this.deps.messaging.sendToChannel(params.channelId, `⚠️ ${resolved.error || 'worker not found'}`);
        return;
      }
      const worker = resolved.worker;

      const outcome = await this.dispatchOrQueueOrchestratorWorkerTask({
        projectName: params.projectName,
        normalizedProject: params.normalizedProject,
        supervisorInstanceId: supervisor,
        worker,
        prompt: params.command.prompt,
        sourceChannelId: params.channelId,
        routeHint: params.routeHint,
        allowQueueOnImmediateFailure: true,
        priority: params.command.priority,
      });
      if (outcome.kind === 'dispatched') {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          [
            `✅ Dispatched to worker \`${worker.instanceId}\``,
            `turnId: \`${outcome.turnId}\``,
            `task: ${params.command.prompt.slice(0, 200)}${params.command.prompt.length > 200 ? '…' : ''}`,
          ].join('\n'),
        );
        return;
      }
      if (outcome.kind === 'queued') {
        if (outcome.immediateFailureQueued) {
          await this.deps.messaging.sendToChannel(
            params.channelId,
            [
              `⚠️ Immediate dispatch failed for worker \`${worker.instanceId}\`; queued for retry.`,
              `turnId: \`${outcome.turnId}\``,
              `queue depth: \`${outcome.queueDepth ?? 0}\``,
            ].join('\n'),
          );
          return;
        }
        await this.deps.messaging.sendToChannel(
          params.channelId,
          [
            `🕒 Queued for worker \`${worker.instanceId}\``,
            `turnId: \`${outcome.turnId}\``,
            `queue position: \`${outcome.queuePosition ?? outcome.queueDepth ?? 1}\``,
            `task: ${params.command.prompt.slice(0, 200)}${params.command.prompt.length > 200 ? '…' : ''}`,
          ].join('\n'),
        );
        return;
      }
      if (outcome.kind === 'queue-full') {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Worker \`${worker.instanceId}\` queue is full. Increase \`AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_DEPTH\` or wait for drain.`,
        );
        return;
      }
      await this.deps.messaging.sendToChannel(
        params.channelId,
        this.buildDeliveryFailureGuidance(params.projectName, outcome.errorMessage || 'dispatch failed'),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-spawn') {
      const orchestrator = params.normalizedProject.orchestrator;
      if (!orchestrator?.enabled) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Orchestrator is disabled. Run `/orchestrator enable` first.',
        );
        return;
      }
      const supervisor = orchestrator.supervisorInstanceId;
      if (!supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor is not configured. Re-run `/orchestrator enable <supervisorInstanceId>`.',
        );
        return;
      }
      if (params.instanceId !== supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Only supervisor \`${supervisor}\` can spawn worker instances.`,
        );
        return;
      }
      if (!this.deps.orchestratorWorkerProvisioner) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Dynamic worker provisioning is unavailable in this runtime.',
        );
        return;
      }

      const spawnResult = await this.deps.orchestratorWorkerProvisioner.spawnCodexWorkers({
        projectName: params.projectName,
        count: params.command.count,
      });
      if (spawnResult.created.length === 0) {
        const warning = spawnResult.warnings?.[0] || 'no worker created';
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Worker spawn skipped: ${warning}`,
        );
        return;
      }

      const latest = this.deps.stateManager.getProject(params.projectName);
      if (latest) {
        const normalizedLatest = normalizeProjectState(latest);
        const latestOrchestrator = normalizedLatest.orchestrator;
        if (latestOrchestrator?.enabled) {
          const mergedWorkerIds = [
            ...new Set([
              ...(latestOrchestrator.workerInstanceIds || []),
              ...spawnResult.created.map((instance) => instance.instanceId),
            ]),
          ];
          this.deps.stateManager.setProject(
            normalizeProjectState({
              ...normalizedLatest,
              orchestrator: {
                ...latestOrchestrator,
                enabled: true,
                supervisorInstanceId: latestOrchestrator.supervisorInstanceId || supervisor,
                workerInstanceIds: mergedWorkerIds,
              },
              lastActive: new Date(),
            }),
          );
        }
      }

      const warnings = (spawnResult.warnings || []).filter((line) => !!line);
      await this.deps.messaging.sendToChannel(
        params.channelId,
        [
          `✅ Spawned worker instance(s): ${spawnResult.created.map((instance) => `\`${instance.instanceId}\``).join(', ')}`,
          `count: \`${spawnResult.created.length}\``,
          ...(warnings.length > 0 ? [`warnings: ${warnings.join(' | ')}`] : []),
        ].join('\n'),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-remove') {
      const workerToken = params.command.workerInstanceId;
      const orchestrator = params.normalizedProject.orchestrator;
      if (!orchestrator?.enabled) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Orchestrator is disabled. Run `/orchestrator enable` first.',
        );
        return;
      }
      const supervisor = orchestrator.supervisorInstanceId;
      if (!supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor is not configured. Re-run `/orchestrator enable <supervisorInstanceId>`.',
        );
        return;
      }
      if (params.instanceId !== supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Only supervisor \`${supervisor}\` can remove worker instances.`,
        );
        return;
      }
      const resolved = this.resolveWorkerForCommand({
        project: params.normalizedProject,
        workerToken,
      });
      if (!resolved.workerInstanceId || !resolved.worker) {
        await this.deps.messaging.sendToChannel(params.channelId, `⚠️ ${resolved.error || 'worker not found'}`);
        return;
      }
      const workerInstanceId = resolved.workerInstanceId;
      const worker = resolved.worker;
      if (workerInstanceId === supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor instance cannot be removed via `/orchestrator remove`.',
        );
        return;
      }
      if (!this.deps.orchestratorWorkerProvisioner) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Dynamic worker provisioning is unavailable in this runtime.',
        );
        return;
      }

      this.clearOrchestratorQueueForWorker(params.projectName, workerInstanceId);
      this.deps.pendingTracker.clearPendingForInstance(
        params.projectName,
        worker.agentType,
        worker.instanceId,
      );

      const removed = await this.deps.orchestratorWorkerProvisioner.teardownWorker({
        projectName: params.projectName,
        workerInstanceId,
      });
      if (!removed.removed) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Worker remove skipped: ${removed.warning || 'unknown reason'}`,
        );
        return;
      }

      const latest = this.deps.stateManager.getProject(params.projectName);
      if (latest) {
        const normalizedLatest = normalizeProjectState(latest);
        const latestOrchestrator = normalizedLatest.orchestrator;
        if (latestOrchestrator?.enabled) {
          this.deps.stateManager.setProject(
            normalizeProjectState({
              ...normalizedLatest,
              orchestrator: {
                ...latestOrchestrator,
                enabled: true,
                supervisorInstanceId: latestOrchestrator.supervisorInstanceId || supervisor,
                workerInstanceIds: (latestOrchestrator.workerInstanceIds || [])
                  .filter((id) => id !== workerInstanceId),
              },
              lastActive: new Date(),
            }),
          );
        }
      }

      await this.deps.messaging.sendToChannel(
        params.channelId,
        [
          `✅ Removed worker \`${workerInstanceId}\``,
          ...(removed.warning ? [`note: ${removed.warning}`] : []),
        ].join('\n'),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-remove-all') {
      const orchestrator = params.normalizedProject.orchestrator;
      if (!orchestrator?.enabled) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Orchestrator is disabled. Run `/orchestrator enable` first.',
        );
        return;
      }
      const supervisor = orchestrator.supervisorInstanceId;
      if (!supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Supervisor is not configured. Re-run `/orchestrator enable <supervisorInstanceId>`.',
        );
        return;
      }
      if (params.instanceId !== supervisor) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Only supervisor \`${supervisor}\` can remove worker instances.`,
        );
        return;
      }
      if (!this.deps.orchestratorWorkerProvisioner) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '⚠️ Dynamic worker provisioning is unavailable in this runtime.',
        );
        return;
      }

      const workerIds = this.resolveOrchestratorWorkerIds(params.normalizedProject).filter((id) => id !== supervisor);
      if (workerIds.length === 0) {
        await this.deps.messaging.sendToChannel(params.channelId, 'ℹ️ No worker instances to remove.');
        return;
      }

      const removedIds: string[] = [];
      const warnings: string[] = [];
      for (const workerInstanceId of workerIds) {
        const worker = getProjectInstance(params.normalizedProject, workerInstanceId);
        if (!worker) {
          warnings.push(`${workerInstanceId}: not found`);
          continue;
        }
        this.clearOrchestratorQueueForWorker(params.projectName, workerInstanceId);
        this.deps.pendingTracker.clearPendingForInstance(
          params.projectName,
          worker.agentType,
          worker.instanceId,
        );
        const removed = await this.deps.orchestratorWorkerProvisioner.teardownWorker({
          projectName: params.projectName,
          workerInstanceId,
        });
        if (removed.removed) {
          removedIds.push(workerInstanceId);
          if (removed.warning) warnings.push(`${workerInstanceId}: ${removed.warning}`);
        } else {
          warnings.push(`${workerInstanceId}: ${removed.warning || 'remove skipped'}`);
        }
      }

      const latest = this.deps.stateManager.getProject(params.projectName);
      if (latest) {
        const normalizedLatest = normalizeProjectState(latest);
        const latestOrchestrator = normalizedLatest.orchestrator;
        if (latestOrchestrator?.enabled) {
          this.deps.stateManager.setProject(
            normalizeProjectState({
              ...normalizedLatest,
              orchestrator: {
                ...latestOrchestrator,
                enabled: true,
                supervisorInstanceId: latestOrchestrator.supervisorInstanceId || supervisor,
                workerInstanceIds: (latestOrchestrator.workerInstanceIds || [])
                  .filter((id) => !removedIds.includes(id)),
              },
              lastActive: new Date(),
            }),
          );
        }
      }

      await this.deps.messaging.sendToChannel(
        params.channelId,
        [
          `✅ Removed worker instance(s): ${
            removedIds.length > 0 ? removedIds.map((id) => `\`${id}\``).join(', ') : '(none)'
          }`,
          ...(warnings.length > 0 ? [`warnings: ${warnings.join(' | ')}`] : []),
        ].join('\n'),
      );
      return;
    }

    if (params.command.kind === 'orchestrator-disable') {
      this.clearOrchestratorQueueForProject(params.projectName);
      const nextProject = normalizeProjectState({
        ...params.normalizedProject,
        orchestrator: undefined,
        lastActive: new Date(),
      });
      this.deps.stateManager.setProject(nextProject);
      await this.deps.messaging.sendToChannel(params.channelId, '✅ Orchestrator disabled');
      return;
    }

    if (params.command.kind === 'doctor') {
      try {
        const runner = this.deps.doctorRunner || runDoctor;
        const result = await runner({ fix: params.command.fix });
        await this.sendSplitMessage(params.channelId, this.formatDoctorSummary(result));
      } catch (error) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Doctor command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    if (params.command.kind === 'repair') {
      const runDoctorFix = async (): Promise<boolean> => {
        try {
          const runner = this.deps.doctorRunner || runDoctor;
          const result = await runner({ fix: true });
          await this.sendSplitMessage(params.channelId, this.formatDoctorSummary(result));
          if (!result.ok) {
            await this.deps.messaging.sendToChannel(
              params.channelId,
              '⚠️ Repair aborted: doctor reported failure(s).',
            );
            return false;
          }
          return true;
        } catch (error) {
          await this.deps.messaging.sendToChannel(
            params.channelId,
            `⚠️ Repair step failed during doctor run: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      };

      const scheduleDaemonRestart = async (): Promise<boolean> => {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          '♻️ Scheduling daemon restart after repair...',
        );
        try {
          this.scheduleBackgroundCli(['daemon', 'restart'], 500);
          return true;
        } catch (error) {
          await this.deps.messaging.sendToChannel(
            params.channelId,
            `⚠️ Failed to schedule daemon restart: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      };

      const scheduleHealthVerify = async (delayMs: number): Promise<void> => {
        const verifyArgs = ['repair', 'verify', '--project', params.projectName];
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `🩺 Scheduling health verify (\`mudcode ${verifyArgs.join(' ')}\`) ...`,
        );
        try {
          this.scheduleBackgroundCli(verifyArgs, delayMs);
        } catch (error) {
          await this.deps.messaging.sendToChannel(
            params.channelId,
            `⚠️ Failed to schedule health verify: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      if (params.command.mode === 'restart-only') {
        await scheduleDaemonRestart();
        return;
      }

      if (params.command.mode === 'verify') {
        await scheduleHealthVerify(350);
        return;
      }

      await this.deps.messaging.sendToChannel(
        params.channelId,
        params.command.mode === 'doctor-only'
          ? '🛠️ Running doctor auto-fix...'
          : params.command.mode === 'deep'
            ? '🛠️ Running doctor auto-fix, then scheduling daemon restart and verify...'
            : '🛠️ Running doctor auto-fix, then scheduling daemon restart...',
      );

      const doctorOk = await runDoctorFix();
      if (!doctorOk) return;

      if (params.command.mode === 'doctor-only') {
        return;
      }

      const restartScheduled = await scheduleDaemonRestart();
      if (!restartScheduled) return;

      if (params.command.mode === 'deep') {
        await scheduleHealthVerify(5000);
      }
      return;
    }

    if (params.command.kind === 'update') {
      const args = ['update', ...(params.command.git ? ['--git'] : [])];
      const suffix = params.command.git ? ' (`--git`)' : '';
      await this.deps.messaging.sendToChannel(
        params.channelId,
        `⬆️ Starting mudcode update${suffix}. This may restart the daemon shortly.`,
      );
      try {
        // Give Discord send a brief head start before daemon lifecycle changes.
        this.scheduleBackgroundCli(args, 350);
      } catch (error) {
        await this.deps.messaging.sendToChannel(
          params.channelId,
          `⚠️ Failed to schedule update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    await this.deps.messaging.sendToChannel(
      params.channelId,
      '♻️ Scheduling daemon restart...',
    );
    try {
      // Delay to increase chance the acknowledgement message is delivered first.
      this.scheduleBackgroundCli(['daemon', 'restart'], 350);
    } catch (error) {
      await this.deps.messaging.sendToChannel(
        params.channelId,
        `⚠️ Failed to schedule daemon restart: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    this.lastPromptByInstance.delete(this.promptMemoryKey(projectName, instanceId));
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

  private async safeEmitCodexStartEvent(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
  }): Promise<void> {
    const hookClient = this.deps.eventHookClient;
    if (!hookClient?.enabled) return;
    try {
      await hookClient.emitCodexStart(params);
    } catch (error) {
      console.warn(
        `Codex start hook emit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async safeEmitCodexErrorEvent(params: {
    projectName: string;
    instanceId: string;
    turnId?: string;
    channelId?: string;
    text: string;
  }): Promise<void> {
    const hookClient = this.deps.eventHookClient;
    if (!hookClient?.enabled) return;
    try {
      await hookClient.emitCodexError(params);
    } catch (error) {
      console.warn(
        `Codex error hook emit failed: ${error instanceof Error ? error.message : String(error)}`,
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

      let normalizedProject = normalizeProjectState(project);
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
      const isSlashCommandMessage = content.trim().startsWith('/');

      if (!isSlashCommandMessage) {
        normalizedProject = this.maybeAutoEnableOrchestrator({
          projectName,
          normalizedProject,
          resolvedAgentType,
          currentInstanceId: instanceKey,
        });
      }

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

      const utilityCommand = this.parseUtilityCommand(content);
      if (utilityCommand === 'health') {
        await this.sendHealthSummary({
          channelId: commandChannelId,
          projectName,
          normalizedProject,
          resolvedAgentType,
          instanceId: instanceKey,
          windowName,
        });
        return;
      }
      if (utilityCommand === 'snapshot') {
        await this.sendSnapshot({
          channelId: commandChannelId,
          projectName,
          normalizedProject,
          resolvedAgentType,
          instanceId: instanceKey,
          windowName,
        });
        return;
      }
      if (utilityCommand === 'io') {
        const status = this.deps.ioTracker
          ? this.deps.ioTracker.buildStatus(projectName, instanceKey)
          : 'ℹ️ codex i/o tracker is not initialized';
        await messaging.sendToChannel(commandChannelId, status);
        return;
      }

      const maintenanceCommand = this.parseMaintenanceCommand(content);
      if (maintenanceCommand) {
        await this.handleMaintenanceCommand({
          command: maintenanceCommand,
          channelId: commandChannelId,
          projectName,
          normalizedProject,
          routeHint: this.routeHintFor(routeSource, context),
          instanceId: instanceKey,
        });
        return;
      }

      let promptToSend: string | null = null;
      let specialKeyCommand: SpecialKeyCommand | null = null;
      let downloadedAttachmentCount = 0;
      let autoWorkerDispatchOutcomes: Array<{
        workerInstanceId: string;
        outcome: OrchestratorDispatchOrQueueOutcome;
        plannedTask?: string;
        packetArtifactPath?: string;
      }> = [];
      let autoOrchestratorNotices: string[] = [];
      let autoPlannerUsed = false;
      const isRetryCommand = utilityCommand === 'retry';
      if (isRetryCommand) {
        const remembered = this.getRememberedPrompt(projectName, instanceKey);
        if (!remembered) {
          await messaging.sendToChannel(
            channelId,
            '⚠️ No previous prompt found for this instance. Send a normal prompt first.',
          );
          return;
        }
        promptToSend = remembered;
      } else {
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
          if (resolvedAgentType === 'codex') {
            const linked = this.deps.skillAutoLinker?.augmentPrompt({
              agentType: resolvedAgentType,
              projectPath: project.projectPath,
              prompt: sanitized,
            });
            const withSkillHint = linked?.prompt || sanitized;
            const subAgentHinted = this.maybeAugmentCodexPromptForSubAgent(withSkillHint);
            if (subAgentHinted.applied) {
              console.log(
                `🧩 [${projectName}/${resolvedAgentType}] auto sub-agent hint injected (${withSkillHint.length} chars)`,
              );
            }
            const longTaskHinted = this.maybeAugmentCodexPromptForLongTaskReport(subAgentHinted.prompt);
            if (longTaskHinted.applied) {
              console.log(
                `🧭 [${projectName}/${resolvedAgentType}] long-task report hint injected`,
              );
            }
            const languagePolicyHinted = this.maybeAugmentCodexPromptForLanguagePolicy(longTaskHinted.prompt);
            if (languagePolicyHinted.applied) {
              console.log(
                `🌐 [${projectName}/${resolvedAgentType}] language-policy hint injected`,
              );
            }
            promptToSend = languagePolicyHinted.prompt;
          } else {
            promptToSend = sanitized;
          }
        }
      }

      if (
        resolvedAgentType === 'codex' &&
        !specialKeyCommand &&
        !isRetryCommand &&
        promptToSend &&
        promptToSend.trim().length > 0
      ) {
        const prepared = await this.maybeAutoPrepareOrchestrator({
          projectName,
          normalizedProject,
          resolvedAgentType,
          currentInstanceId: instanceKey,
          prompt: promptToSend,
        });
        normalizedProject = prepared.project;
        autoOrchestratorNotices = [...autoOrchestratorNotices, ...prepared.notices];
        const promptForWorkerDispatch = promptToSend;

        const orchestrator = normalizedProject.orchestrator;
        if (
          orchestrator?.enabled &&
          orchestrator.supervisorInstanceId === instanceKey &&
          this.shouldAutoDispatchToWorker(promptForWorkerDispatch)
        ) {
          const workers = this.selectOrchestratorWorkersForDispatch(
            projectName,
            normalizedProject,
            this.resolveOrchestratorAutoDispatchMaxWorkers(),
          );
          const plannerAssignments = this.buildAutoPlannerAssignments({
            projectName,
            projectPath: normalizedProject.projectPath,
            supervisorInstanceId: instanceKey,
            prompt: promptForWorkerDispatch,
            workers,
          });
          autoPlannerUsed = plannerAssignments.length > 0;

          for (let index = 0; index < workers.length; index += 1) {
            const worker = workers[index];
            if (!worker) continue;
            const assignment = plannerAssignments[index];
            const workerPrompt = assignment?.prompt || promptForWorkerDispatch;
            const outcome = await this.dispatchOrQueueOrchestratorWorkerTask({
              projectName,
              normalizedProject,
              supervisorInstanceId: instanceKey,
              worker,
              prompt: workerPrompt,
              sourceChannelId: commandChannelId,
              routeHint: this.routeHintFor(routeSource, context),
              allowQueueOnImmediateFailure: true,
            });
            autoWorkerDispatchOutcomes.push({
              workerInstanceId: worker.instanceId,
              outcome,
              ...(assignment ? { plannedTask: assignment.task } : {}),
              ...(assignment?.packetArtifactPath
                ? { packetArtifactPath: assignment.packetArtifactPath }
                : {}),
            });
          }
        }

        const supervisorGuarded = this.maybeAugmentCodexPromptForSupervisorOrchestrationGuard({
          prompt: promptToSend,
          normalizedProject,
          supervisorInstanceId: instanceKey,
        });
        if (supervisorGuarded.applied) {
          promptToSend = supervisorGuarded.prompt;
          console.log(`🛡️ [${projectName}/${resolvedAgentType}] supervisor orchestration guard injected`);
        }
      }

      if (messageId) {
        await this.safePendingUpdate('message:markPending', () =>
          this.deps.pendingTracker.markPending(
            projectName,
            resolvedAgentType,
            commandChannelId,
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
          if (promptToSend && promptToSend.trim().length > 0) {
            this.deps.ioTracker?.recordPromptSubmitted({
              projectName,
              instanceId: instanceKey,
              channelId: commandChannelId,
              projectPath: project.projectPath,
              prompt: promptToSend,
            });
          }
          void this.safeEmitCodexStartEvent({
            projectName,
            instanceId: instanceKey,
            turnId: messageId,
            channelId: commandChannelId,
          });
          delivered = true;
        } else {
          this.deps.tmux.sendKeysToWindow(normalizedProject.tmuxSession, windowName, promptToSend || '', resolvedAgentType);
          delivered = true;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (resolvedAgentType === 'codex') {
          this.deps.ioTracker?.recordTurnFailed({
            projectName,
            instanceId: instanceKey,
            channelId: commandChannelId,
            reason: errorMessage,
          });
          void this.safeEmitCodexErrorEvent({
            projectName,
            instanceId: instanceKey,
            turnId: messageId,
            channelId: commandChannelId,
            text: errorMessage,
          });
        }
        await this.safePendingUpdate('message:markError', () =>
          this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey, 'tail'),
        );
        await messaging.sendToChannel(channelId, this.buildDeliveryFailureGuidance(projectName, error));
      }

      if (delivered) {
        if (!specialKeyCommand && promptToSend && promptToSend.trim().length > 0) {
          this.rememberPrompt(projectName, instanceKey, promptToSend);
        }
        this.rememberMessageRoute(messageId, routeMemory);
        this.rememberConversationRoute(context?.conversationKey, routeMemory);
        if (autoOrchestratorNotices.length > 0) {
          await messaging.sendToChannel(commandChannelId, autoOrchestratorNotices.join('\n'));
        }
        if (autoWorkerDispatchOutcomes.length === 1) {
          const single = autoWorkerDispatchOutcomes[0]!;
          const autoWorkerDispatchOutcome = single.outcome;
          const autoWorkerInstanceId = single.workerInstanceId;
          const plannedTaskLine = single.plannedTask ? [`task: ${single.plannedTask}`] : [];
          const packetPathLine = single.packetArtifactPath ? [`packet: ${single.packetArtifactPath}`] : [];
          if (autoWorkerDispatchOutcome.kind === 'dispatched') {
            await messaging.sendToChannel(
              commandChannelId,
              [
                `🧠 Auto orchestration: dispatched supporting task to worker \`${autoWorkerInstanceId}\``,
                `turnId: \`${autoWorkerDispatchOutcome.turnId}\``,
                ...plannedTaskLine,
                ...packetPathLine,
              ].join('\n'),
            );
          } else if (autoWorkerDispatchOutcome.kind === 'queued') {
            await messaging.sendToChannel(
              commandChannelId,
              [
                `🧠 Auto orchestration: queued supporting task for worker \`${autoWorkerInstanceId}\``,
                `turnId: \`${autoWorkerDispatchOutcome.turnId}\``,
                `queue position: \`${autoWorkerDispatchOutcome.queuePosition ?? autoWorkerDispatchOutcome.queueDepth ?? 1}\``,
                ...plannedTaskLine,
                ...packetPathLine,
              ].join('\n'),
            );
          } else if (autoWorkerDispatchOutcome.kind === 'queue-full') {
            await messaging.sendToChannel(
              commandChannelId,
              `⚠️ Auto orchestration skipped: worker \`${autoWorkerInstanceId}\` queue is full.`,
            );
          } else if (autoWorkerDispatchOutcome.kind === 'dispatch-failed') {
            await messaging.sendToChannel(
              commandChannelId,
              `⚠️ Auto orchestration worker dispatch failed for \`${autoWorkerInstanceId}\`: ${autoWorkerDispatchOutcome.errorMessage || 'unknown error'}`,
            );
          }
        } else if (autoWorkerDispatchOutcomes.length > 1) {
          const lines = [
            `🧠 Auto orchestration fanout${autoPlannerUsed ? ' (planner)' : ''}:`,
          ];
          for (const item of autoWorkerDispatchOutcomes) {
            const outcome = item.outcome;
            const workerId = item.workerInstanceId;
            const taskSuffix = item.plannedTask ? ` | task=${item.plannedTask}` : '';
            const packetSuffix = item.packetArtifactPath ? ` | packet=${item.packetArtifactPath}` : '';
            if (outcome.kind === 'dispatched') {
              lines.push(`- \`${workerId}\`: dispatched (\`${outcome.turnId}\`)${taskSuffix}${packetSuffix}`);
            } else if (outcome.kind === 'queued') {
              lines.push(
                `- \`${workerId}\`: queued (\`${outcome.turnId}\`, pos=${outcome.queuePosition ?? outcome.queueDepth ?? 1})${taskSuffix}${packetSuffix}`,
              );
            } else if (outcome.kind === 'queue-full') {
              lines.push(`- \`${workerId}\`: queue full${taskSuffix}${packetSuffix}`);
            } else {
              lines.push(
                `- \`${workerId}\`: failed (${outcome.errorMessage || 'unknown error'})${taskSuffix}${packetSuffix}`,
              );
            }
          }
          await messaging.sendToChannel(commandChannelId, lines.join('\n'));
        }
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

  private getEnvBool(name: string, defaultValue: boolean): boolean {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
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

    const trimmedPrompt = prompt.trimEnd();
    this.deps.tmux.typeKeysToWindow(tmuxSession, windowName, trimmedPrompt, 'codex');
    const delayMs = this.getEnvInt('AGENT_DISCORD_CODEX_SUBMIT_DELAY_MS', 75);
    await this.sleep(delayMs);
    this.deps.tmux.sendEnterToWindow(tmuxSession, windowName, 'codex');

    const tmuxChunkSize = Math.max(1, this.getEnvInt('AGENT_DISCORD_TMUX_SEND_KEYS_CHUNK_SIZE', 2000));
    const promptLength = trimmedPrompt.length;
    const estimatedChunkCount = Math.max(1, Math.ceil(promptLength / tmuxChunkSize));
    const exactChunkBoundary = promptLength > 0 && (promptLength % tmuxChunkSize === 0);
    const autoBoundaryRetry = this.getEnvBool('AGENT_DISCORD_CODEX_AUTO_REENTER_CHUNK_BOUNDARY', true);

    // Codex can occasionally miss the first Enter for very long typed payloads.
    // Send one follow-up Enter to match the observed manual recovery (/enter).
    const retryThreshold = this.getEnvInt('AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_THRESHOLD', 3500);
    let shouldRetrySubmit = trimmedPrompt.length >= Math.max(1, retryThreshold);
    if (!shouldRetrySubmit && autoBoundaryRetry && (estimatedChunkCount >= 2 || exactChunkBoundary)) {
      // Auto-tuned guard for 2000-char tmux send-keys boundary and multi-chunk prompts.
      shouldRetrySubmit = true;
    }
    if (!shouldRetrySubmit) {
      const verifyDelayMs = this.getEnvInt('AGENT_DISCORD_CODEX_SUBMIT_VERIFY_DELAY_MS', 140);
      await this.sleep(Math.max(0, verifyDelayMs));
      shouldRetrySubmit = this.shouldRetryCodexSubmit(tmuxSession, windowName, trimmedPrompt);
    }

    if (shouldRetrySubmit) {
      const retryDelayMs = this.getEnvInt('AGENT_DISCORD_CODEX_LONG_PROMPT_REENTER_DELAY_MS', 120);
      await this.sleep(Math.max(0, retryDelayMs));
      this.deps.tmux.sendEnterToWindow(tmuxSession, windowName, 'codex');
    }
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
