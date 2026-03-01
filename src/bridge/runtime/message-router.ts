import type { MessageContext, MessagingClient } from '../../messaging/interface.js';
import { TmuxManager } from '../../tmux/manager.js';
import type { IStateManager } from '../../types/interfaces.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
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
import { runDoctor, type DoctorResult } from '../../cli/commands/doctor.js';

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
  | { kind: 'daemon-restart' };
type CodexLongTaskReportMode = 'off' | 'continue' | 'auto' | 'always';

export class BridgeMessageRouter {
  private routeByMessageId: Map<string, RouteMemory> = new Map();
  private routeByConversationKey: Map<string, RouteMemory> = new Map();
  private lastPromptByInstance: Map<string, string> = new Map();
  private readonly maxMessageRoutes = 4000;
  private readonly maxConversationRoutes = 2000;
  private readonly maxPromptMemory = 2000;

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

  private parseUtilityCommand(content: string): 'retry' | 'health' | 'snapshot' | 'io' | undefined {
    const normalized = content.trim().toLowerCase();
    if (normalized === '/retry') return 'retry';
    if (normalized === '/health') return 'health';
    if (normalized === '/snapshot') return 'snapshot';
    if (normalized === '/io') return 'io';
    return undefined;
  }

  private parseMaintenanceCommand(content: string): MaintenanceCommand | undefined {
    const parts = content.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return undefined;
    const command = parts[0]!.toLowerCase();

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

    return undefined;
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

  private maybeAugmentCodexPromptForSubAgent(prompt: string): { prompt: string; applied: boolean } {
    if (!this.getEnvBool('AGENT_DISCORD_CODEX_AUTO_SUBAGENT', true)) {
      return { prompt, applied: false };
    }
    if (prompt.trim().length === 0) return { prompt, applied: false };
    if (this.hasExplicitSubAgentRequest(prompt)) return { prompt, applied: false };
    if (!this.isLargeContextPrompt(prompt)) return { prompt, applied: false };

    const hint = [
      '[mudcode auto-subagent]',
      'This request looks context-heavy. Split work and run focused sub-agent Codex workers.',
      '- Create 2-4 sub-agents with explicit ownership (files/responsibility).',
      '- Run independent chunks in parallel, then merge and verify once.',
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

  private isCodexContinuationPrompt(prompt: string): boolean {
    const normalized = prompt.trim().toLowerCase();
    if (normalized.length === 0) return false;
    if (normalized === 'continue') return true;
    if (normalized.startsWith('continue ')) return true;
    if (normalized === 'go on' || normalized.startsWith('go on ')) return true;
    if (normalized === 'keep going' || normalized.startsWith('keep going ')) return true;
    if (normalized === '계속' || normalized.startsWith('계속 ')) return true;
    if (normalized === '계속해' || normalized.startsWith('계속해 ')) return true;
    if (normalized === '계속 진행' || normalized.startsWith('계속 진행')) return true;
    if (normalized === '쭉' || normalized.startsWith('쭉 ')) return true;
    if (normalized === '진행' || normalized.startsWith('진행 ')) return true;
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
  }): Promise<void> {
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
        });
        return;
      }

      let promptToSend: string | null = null;
      let specialKeyCommand: SpecialKeyCommand | null = null;
      let downloadedAttachmentCount = 0;
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
            promptToSend = longTaskHinted.prompt;
          } else {
            promptToSend = sanitized;
          }
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
