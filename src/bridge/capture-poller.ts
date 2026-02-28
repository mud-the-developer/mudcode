import { cleanCapture, splitForDiscord, splitForSlack } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import { listProjectInstances, normalizeProjectState } from '../state/instances.js';
import { TmuxManager } from '../tmux/manager.js';
import type { IStateManager } from '../types/interfaces.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import { formatDiscordOutput, wrapDiscordCodeblock } from './discord-output-formatter.js';
import type { CodexIoV2Tracker } from './codex-io-v2.js';

export interface BridgeCapturePollerDeps {
  messaging: MessagingClient;
  tmux: TmuxManager;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  ioTracker?: CodexIoV2Tracker;
  intervalMs?: number;
  quietPendingPollThreshold?: number;
  codexInitialQuietPendingPollThreshold?: number;
  codexFinalOnlyModeEnabled?: boolean;
  longOutputThreadThreshold?: number;
  stalePendingAlertMs?: number;
  promptEchoFilterEnabled?: boolean;
  promptEchoSuppressionMaxPolls?: number;
  redrawFallbackTailLines?: number;
}

export class BridgeCapturePoller {
  private readonly intervalMs: number;
  private readonly quietPendingPollThreshold: number;
  private readonly codexInitialQuietPendingPollThreshold: number;
  private readonly codexFinalOnlyModeEnabled: boolean;
  private readonly longOutputThreadThreshold: number;
  private readonly stalePendingAlertMs: number;
  private readonly promptEchoFilterEnabled: boolean;
  private readonly promptEchoSuppressionMaxPolls: number;
  private readonly redrawFallbackTailLines: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private snapshotsByInstance = new Map<string, string>();
  private lastCaptureMutationAtByInstance = new Map<string, number>();
  private stalePendingAlertStageByInstance = new Map<string, number>();
  private completionCandidatesByInstance = new Map<
    string,
    { projectName: string; agentType: string; instanceId: string }
  >();
  private quietPendingPollsByInstance = new Map<
    string,
    { count: number; projectName: string; agentType: string; instanceId: string }
  >();
  private finalOnlyQuietFlushPollsByInstance = new Map<string, number>();
  private promptEchoSuppressedPollsByInstance = new Map<string, number>();
  private bufferedOutputByInstance = new Map<string, string>();
  private bufferedOutputChannelByInstance = new Map<string, string>();

  constructor(private deps: BridgeCapturePollerDeps) {
    this.intervalMs = this.resolveIntervalMs(deps.intervalMs);
    this.quietPendingPollThreshold = this.resolveQuietPendingPollThreshold(deps.quietPendingPollThreshold);
    this.codexInitialQuietPendingPollThreshold = this.resolveCodexInitialQuietPendingPollThreshold(
      deps.codexInitialQuietPendingPollThreshold,
    );
    this.codexFinalOnlyModeEnabled = this.resolveCodexFinalOnlyModeEnabled(deps.codexFinalOnlyModeEnabled);
    this.longOutputThreadThreshold = this.resolveLongOutputThreadThreshold(deps.longOutputThreadThreshold);
    this.stalePendingAlertMs = this.resolveStalePendingAlertMs(deps.stalePendingAlertMs);
    this.promptEchoFilterEnabled = this.resolvePromptEchoFilterEnabled(deps.promptEchoFilterEnabled);
    this.promptEchoSuppressionMaxPolls = this.resolvePromptEchoSuppressionMaxPolls(deps.promptEchoSuppressionMaxPolls);
    this.redrawFallbackTailLines = this.resolveRedrawFallbackTailLines(deps.redrawFallbackTailLines);
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);

    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    this.lastCaptureMutationAtByInstance.clear();
    this.stalePendingAlertStageByInstance.clear();
    this.completionCandidatesByInstance.clear();
    this.quietPendingPollsByInstance.clear();
    this.finalOnlyQuietFlushPollsByInstance.clear();
    this.promptEchoSuppressedPollsByInstance.clear();
    this.bufferedOutputByInstance.clear();
    this.bufferedOutputChannelByInstance.clear();
  }

  private resolveIntervalMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 250) {
      return Math.trunc(configured);
    }

    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_POLL_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 250) {
      return Math.trunc(fromEnv);
    }

    return 3000;
  }

  private resolveQuietPendingPollThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1) {
      return Math.trunc(fromEnv);
    }
    return 2;
  }

  private resolveCodexInitialQuietPendingPollThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 0) {
      return Math.trunc(fromEnv);
    }
    // Default: do not auto-complete codex pending before first visible output.
    // This avoids showing ✅ too early when codex is still thinking silently.
    return 0;
  }

  private resolveCodexFinalOnlyModeEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;
    const raw = process.env.AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolveLongOutputThreadThreshold(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1200) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1200) {
      return Math.trunc(fromEnv);
    }
    return 2000;
  }

  private resolveStalePendingAlertMs(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1000) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_STALE_ALERT_MS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1000) {
      return Math.trunc(fromEnv);
    }
    return 60000;
  }

  private resolvePromptEchoFilterEnabled(configured?: boolean): boolean {
    if (typeof configured === 'boolean') return configured;
    const raw = process.env.AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO;
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return true;
  }

  private resolvePromptEchoSuppressionMaxPolls(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 1 && configured <= 20) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 20) {
      return Math.trunc(fromEnv);
    }
    return 4;
  }

  private resolveRedrawFallbackTailLines(configured?: number): number {
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 10 && configured <= 400) {
      return Math.trunc(configured);
    }
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 10 && fromEnv <= 400) {
      return Math.trunc(fromEnv);
    }
    return 60;
  }

  private formatDuration(ms: number): string {
    const sec = Math.max(1, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    return `${min}m`;
  }

  private markCaptureMutation(key: string, now: number): void {
    this.lastCaptureMutationAtByInstance.set(key, now);
    this.stalePendingAlertStageByInstance.delete(key);
    this.finalOnlyQuietFlushPollsByInstance.delete(key);
  }

  private clearStalePendingAlertState(key: string): void {
    this.lastCaptureMutationAtByInstance.delete(key);
    this.stalePendingAlertStageByInstance.delete(key);
  }

  private resolveNextStalePendingAlertStage(elapsedMs: number, currentStage: number): number {
    if (currentStage < 1 && elapsedMs >= this.stalePendingAlertMs) {
      return 1;
    }
    if (currentStage < 2 && elapsedMs >= this.stalePendingAlertMs * 2) {
      return 2;
    }
    return currentStage;
  }

  private async maybeSendStalePendingAlert(params: {
    key: string;
    pendingDepth: number;
    channelId?: string;
    projectName: string;
    agentType: string;
    instanceId: string;
    now: number;
  }): Promise<void> {
    if (params.pendingDepth <= 0) {
      this.clearStalePendingAlertState(params.key);
      return;
    }
    if (!params.channelId) return;

    const baseline = this.lastCaptureMutationAtByInstance.get(params.key);
    if (typeof baseline !== 'number') {
      this.lastCaptureMutationAtByInstance.set(params.key, params.now);
      return;
    }

    const elapsed = params.now - baseline;
    const currentStage = this.stalePendingAlertStageByInstance.get(params.key) ?? 0;
    const nextStage = this.resolveNextStalePendingAlertStage(elapsed, currentStage);
    if (nextStage === currentStage) return;

    const instanceLabel = params.instanceId || params.agentType;
    const durationLabel =
      nextStage === 1 ? this.formatDuration(this.stalePendingAlertMs) : this.formatDuration(this.stalePendingAlertMs * 2);
    const alertMessage =
      nextStage === 1
        ? `⚠️ No screen updates for ${durationLabel} on \`${params.projectName}/${instanceLabel}\`. It may be stuck. Try \`/retry\` or \`/health\`.`
        : `🚨 Still no screen updates for ${durationLabel} on \`${params.projectName}/${instanceLabel}\`. Try \`/esc\` then \`/retry\`, and check \`/health\`.`;
    await this.deps.messaging
      .sendToChannel(params.channelId, alertMessage)
      .catch(() => undefined);
    this.stalePendingAlertStageByInstance.set(params.key, nextStage);
  }

  private shouldUseThreadedLongOutput(text: string): boolean {
    return (
      this.deps.messaging.platform === 'discord' &&
      text.length >= this.longOutputThreadThreshold &&
      typeof this.deps.messaging.sendLongOutput === 'function'
    );
  }

  private async sendOutput(channelId: string, text: string): Promise<boolean> {
    const discordFormatted =
      this.deps.messaging.platform === 'discord'
        ? formatDiscordOutput(text)
        : { text, useCodeblock: false, language: 'text' };
    const content = discordFormatted.text;
    if (content.trim().length === 0) return false;

    if (this.shouldUseThreadedLongOutput(content)) {
      await this.deps.messaging.sendLongOutput!(channelId, content);
      return true;
    }

    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    let sentAnyChunk = false;
    for (const chunk of split(content)) {
      if (chunk.trim().length === 0) continue;
      const payload =
        this.deps.messaging.platform === 'discord' && discordFormatted.useCodeblock
          ? wrapDiscordCodeblock(chunk, discordFormatted.language)
          : chunk;
      await this.deps.messaging.sendToChannel(channelId, payload);
      sentAnyChunk = true;
    }
    return sentAnyChunk;
  }

  private shouldBufferUntilCompletion(key: string, agentType: string, pendingDepth: number): boolean {
    return (
      this.codexFinalOnlyModeEnabled &&
      agentType === 'codex' &&
      (pendingDepth > 0 || this.bufferedOutputByInstance.has(key))
    );
  }

  private appendBufferedOutput(key: string, text: string, channelId?: string, agentType: string = ''): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (channelId && !this.bufferedOutputChannelByInstance.has(key)) {
      this.bufferedOutputChannelByInstance.set(key, channelId);
    }
    const previous = this.bufferedOutputByInstance.get(key);
    if (!previous) {
      const initial =
        this.codexFinalOnlyModeEnabled && agentType === 'codex'
          ? this.prepareCodexFinalOnlyOutput(trimmed)
          : trimmed;
      if (initial.trim().length === 0) return;
      this.bufferedOutputByInstance.set(key, this.trimTailLines(initial, 320));
      return;
    }
    const merged = this.mergeBufferedOutput(previous, trimmed, agentType);
    if (merged.trim().length === 0) return;
    this.bufferedOutputByInstance.set(key, merged);
  }

  private mergeBufferedOutput(previous: string, incoming: string, agentType: string): string {
    const overlap = this.longestSuffixPrefix(previous, incoming);
    const merged = overlap > 0 ? `${previous}${incoming.slice(overlap)}` : `${previous}\n${incoming}`;
    const normalized =
      this.codexFinalOnlyModeEnabled && agentType === 'codex'
        ? this.prepareCodexFinalOnlyOutput(merged)
        : merged;
    return this.trimTailLines(normalized, 320);
  }

  private trimTailLines(text: string, maxLines: number): string {
    const lines = text.split('\n');
    if (lines.length <= maxLines) return text;
    return lines.slice(lines.length - maxLines).join('\n');
  }

  private prepareCodexFinalOnlyOutput(text: string): string {
    const sourceLines = text
      .split('\n')
      .map((line) => line.replace(/\r/g, '').trimEnd());
    const kept: string[] = [];
    let lastWasBlank = false;

    for (const raw of sourceLines) {
      const compact = raw.trim();
      if (compact.length === 0) {
        if (!lastWasBlank && kept.length > 0) {
          kept.push('');
        }
        lastWasBlank = true;
        continue;
      }

      if (this.isCodexIntermediaryBridgeLine(compact)) {
        continue;
      }

      kept.push(raw);
      lastWasBlank = false;
    }

    const compact = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (compact.length === 0) return '';

    const compactLines = compact.split('\n');
    let lastAssistantLine = -1;
    for (let i = compactLines.length - 1; i >= 0; i -= 1) {
      if (/^assistant\s*:/i.test(compactLines[i]!.trim())) {
        lastAssistantLine = i;
        break;
      }
    }
    if (lastAssistantLine >= 0) {
      return compactLines.slice(lastAssistantLine).join('\n').trim();
    }

    return compact;
  }

  private isCodexIntermediaryBridgeLine(line: string): boolean {
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;
    if (this.isCodexUiProgressNoiseLine(compact)) return true;
    if (this.isCodexUiStatusNoiseLine(compact)) return true;
    if (/^›(?:\s.*)?$/.test(compact)) return true;
    if (/^[-─]{20,}$/.test(compact)) return true;
    if (/^[│└├]/.test(compact)) return true;
    if (/^would you like to run the following command\?/i.test(compact)) return true;
    if (/^press enter to confirm or esc to cancel$/i.test(compact)) return true;
    if (/^\d+\.\s+(yes|no)\b/i.test(compact)) return true;
    if (/^token usage:/i.test(compact)) return true;
    if (/^to continue this session, run codex resume\b/i.test(compact)) return true;
    if (/^tip:\s/i.test(compact)) return true;
    if (/^⚠\s*mcp /i.test(compact)) return true;
    if (/^⚠\s*`?collab`?\s+is deprecated/i.test(compact)) return true;
    if (
      /^•\s*(ran|explored|read|search|find|list|open(?:ed)?|click(?:ed)?|screenshot|apply|applied|edit(?:ed|ing)?|update(?:d|ing)?|create(?:d|ing)?|delete(?:d|ing)?|move(?:d|ing)?|analy(?:ze|zing)|check(?:ing)?|verify|verifying|inspect(?:ing)?|debug(?:ging)?|run(?:ning)?|execute|executing)\b/i.test(
        compact,
      )
    ) {
      return true;
    }
    return false;
  }

  private isLikelyCodexReadyForInput(captureSnapshot: string): boolean {
    if (!captureSnapshot || captureSnapshot.trim().length === 0) return false;

    const lines = captureSnapshot
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return false;

    const tail = lines.slice(-24);
    if (tail.some((line) => /^esc to interrupt\b/i.test(line))) return false;

    const promptPattern = /^›(?:\s.*)?$/;
    const bottomSlice = tail.slice(-4);
    const promptNearBottom = bottomSlice.some((line) => promptPattern.test(line));
    if (!promptNearBottom) return false;

    const lastLine = tail[tail.length - 1] || '';
    if (promptPattern.test(lastLine)) return true;

    // In Codex full-screen UI, footer often sits below the input prompt.
    const footerNearBottom = bottomSlice.some((line) => this.isCodexUiStatusNoiseLine(line));
    return footerNearBottom;
  }

  private hasCodexWorkingMarker(captureSnapshot: string): boolean {
    const lines = captureSnapshot
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return false;

    const tail = lines.slice(-24);
    return tail.some((line) => /\besc to interrupt\b/.test(line));
  }

  private async flushBufferedOutput(key: string, channelId?: string, agentType: string = ''): Promise<boolean> {
    const buffered = this.bufferedOutputByInstance.get(key);
    if (!buffered || buffered.trim().length === 0) {
      this.bufferedOutputByInstance.delete(key);
      this.bufferedOutputChannelByInstance.delete(key);
      return false;
    }
    const targetChannelId = this.bufferedOutputChannelByInstance.get(key) || channelId;
    if (!targetChannelId) return false;

    const prepared =
      this.codexFinalOnlyModeEnabled && agentType === 'codex'
        ? this.prepareCodexFinalOnlyOutput(buffered)
        : buffered.trim();
    if (this.codexFinalOnlyModeEnabled && agentType === 'codex' && prepared.trim().length === 0) {
      this.bufferedOutputByInstance.delete(key);
      this.bufferedOutputChannelByInstance.delete(key);
      return true;
    }
    const output = prepared.trim().length > 0 ? prepared : buffered.trim();
    const sent = await this.sendOutput(targetChannelId, output);
    if (!sent) return false;

    this.bufferedOutputByInstance.delete(key);
    this.bufferedOutputChannelByInstance.delete(key);
    return sent;
  }

  private async deliverDelta(params: {
    projectName: string;
    instanceId: string;
    key: string;
    agentType: string;
    pendingDepth: number;
    codexWorkingHint?: boolean;
    channelId?: string;
    deltaText: string;
  }): Promise<boolean> {
    const trimmed = params.deltaText.trim();
    if (trimmed.length === 0) return false;
    if (params.agentType === 'codex') {
      this.deps.ioTracker?.recordOutputDelta({
        projectName: params.projectName,
        instanceId: params.instanceId,
        channelId: params.channelId,
        deltaText: trimmed,
      });
    }

    if (this.codexFinalOnlyModeEnabled && params.agentType === 'codex') {
      // Any newly observed codex output means we're not in a quiet window anymore.
      this.finalOnlyQuietFlushPollsByInstance.delete(params.key);
    }

    const shouldBuffer =
      this.shouldBufferUntilCompletion(params.key, params.agentType, params.pendingDepth) ||
      (
        this.codexFinalOnlyModeEnabled &&
        params.agentType === 'codex' &&
        params.codexWorkingHint === true
      );
    if (shouldBuffer) {
      this.appendBufferedOutput(params.key, trimmed, params.channelId, params.agentType);
      return true;
    }

    if (!params.channelId) return false;
    return this.sendOutput(params.channelId, trimmed);
  }

  private async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const projects = this.deps.stateManager.listProjects();
      for (const rawProject of projects) {
        const project = normalizeProjectState(rawProject);
        const instances = listProjectInstances(project);

        for (const instance of instances) {
          if (instance.eventHook) continue;
          if (!instance.channelId) continue;

          const key = this.captureKey(project.projectName, instance.instanceId);
          const now = Date.now();
          const routeInfo = this.resolveOutputRoute(
            instance.channelId,
            project.projectName,
            instance.agentType,
            instance.instanceId,
          );

          const targetWindow = instance.tmuxWindow || instance.instanceId;
          if (!targetWindow) continue;

          let captureRaw: string;
          try {
            captureRaw = this.deps.tmux.capturePaneFromWindow(
              project.tmuxSession,
              targetWindow,
              instance.agentType,
            );
          } catch {
            continue;
          }

          if (typeof captureRaw !== 'string') continue;
          const current = cleanCapture(captureRaw);
          if (!current || current.trim().length === 0) {
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          const previous = this.snapshotsByInstance.get(key);
          this.snapshotsByInstance.set(key, current);

          // First snapshot establishes baseline and avoids sending historical backlog.
          if (previous === undefined) {
            this.markCaptureMutation(key, now);
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          if (previous === current) {
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
            continue;
          }

          this.markCaptureMutation(key, now);

          const delta = this.normalizeDeltaForAgent(
            instance.agentType,
            this.extractDelta(instance.agentType, previous, current),
            previous,
            current,
          );
          const codexWorkingHint =
            instance.agentType === 'codex' && this.hasCodexWorkingMarker(current);
          const normalizedForPendingPrompt = this.promptEchoFilterEnabled
            ? this.stripPendingPromptEcho(
                project.projectName,
                instance.agentType,
                instance.instanceId,
                routeInfo.pendingDepth,
                delta,
              )
            : delta;
          const trimmedDelta = normalizedForPendingPrompt.trim();
          if (trimmedDelta.length === 0) {
            const suppressedByPromptEcho = delta.trim().length > 0;
            if (suppressedByPromptEcho) {
              const nextSuppressedCount = (this.promptEchoSuppressedPollsByInstance.get(key) || 0) + 1;
              this.promptEchoSuppressedPollsByInstance.set(key, nextSuppressedCount);

              if (nextSuppressedCount <= this.promptEchoSuppressionMaxPolls) {
                // Treat prompt-echo-only frames as activity for a short buffer.
                // This avoids premature completion before real assistant output.
                this.quietPendingPollsByInstance.delete(key);
                continue;
              }

              // Failsafe: after repeated suppressions, stop swallowing deltas.
              // This avoids "typing forever" when filtering is too aggressive.
              this.promptEchoSuppressedPollsByInstance.delete(key);
              const outputChannelId = routeInfo.channelId;
              if (
                !outputChannelId &&
                !this.shouldBufferUntilCompletion(key, instance.agentType, routeInfo.pendingDepth)
              ) {
                await this.handleQuietPending(
                  key,
                  routeInfo.pendingDepth,
                  project.projectName,
                  instance.agentType,
                  instance.instanceId,
                  routeInfo.channelId || instance.channelId,
                  current,
                );
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
                continue;
              }

              const fallbackSent = await this.deliverDelta({
                projectName: project.projectName,
                instanceId: instance.instanceId,
                key,
                agentType: instance.agentType,
                pendingDepth: routeInfo.pendingDepth,
                codexWorkingHint,
                channelId: outputChannelId,
                deltaText: delta,
              });
              if (fallbackSent) {
                this.quietPendingPollsByInstance.delete(key);
                if (routeInfo.pendingDepth > 0) {
                  this.completionCandidatesByInstance.set(key, {
                    projectName: project.projectName,
                    agentType: instance.agentType,
                    instanceId: instance.instanceId,
                  });
                } else {
                  this.completionCandidatesByInstance.delete(key);
                }
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
              } else {
                await this.handleQuietPending(
                  key,
                  routeInfo.pendingDepth,
                  project.projectName,
                  instance.agentType,
                  instance.instanceId,
                  routeInfo.channelId || instance.channelId,
                  current,
                );
                await this.maybeSendStalePendingAlert({
                  key,
                  pendingDepth: routeInfo.pendingDepth,
                  channelId: routeInfo.channelId || instance.channelId,
                  projectName: project.projectName,
                  agentType: instance.agentType,
                  instanceId: instance.instanceId,
                  now,
                });
              }
              continue;
            }
            this.promptEchoSuppressedPollsByInstance.delete(key);
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
            );
            continue;
          }

          this.promptEchoSuppressedPollsByInstance.delete(key);
          const outputChannelId = routeInfo.channelId;
          if (!outputChannelId && !this.shouldBufferUntilCompletion(key, instance.agentType, routeInfo.pendingDepth)) {
            continue;
          }

          const sentAnyChunk = await this.deliverDelta({
            projectName: project.projectName,
            instanceId: instance.instanceId,
            key,
            agentType: instance.agentType,
            pendingDepth: routeInfo.pendingDepth,
            codexWorkingHint,
            channelId: outputChannelId,
            deltaText: trimmedDelta,
          });

          if (sentAnyChunk) {
            this.quietPendingPollsByInstance.delete(key);
            if (routeInfo.pendingDepth > 0) {
              // Keep completion buffered until output has been quiet long enough.
              this.completionCandidatesByInstance.set(key, {
                projectName: project.projectName,
                agentType: instance.agentType,
                instanceId: instance.instanceId,
              });
            } else {
              this.completionCandidatesByInstance.delete(key);
            }
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
          } else {
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
              routeInfo.channelId || instance.channelId,
              current,
            );
            await this.maybeSendStalePendingAlert({
              key,
              pendingDepth: routeInfo.pendingDepth,
              channelId: routeInfo.channelId || instance.channelId,
              projectName: project.projectName,
              agentType: instance.agentType,
              instanceId: instance.instanceId,
              now,
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Capture poller iteration failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async handleQuietPending(
    key: string,
    pendingDepth: number,
    projectName: string,
    agentType: string,
    instanceId: string,
    channelId?: string,
    captureSnapshot?: string,
  ): Promise<void> {
    if (pendingDepth <= 0) {
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      if (this.codexFinalOnlyModeEnabled && agentType === 'codex') {
        const codexStillWorking =
          typeof captureSnapshot === 'string' &&
          this.hasCodexWorkingMarker(captureSnapshot);
        if (codexStillWorking) {
          // Tracker may temporarily desync to depth=0 while Codex is still working.
          // Keep final-only buffer until the working marker disappears.
          this.finalOnlyQuietFlushPollsByInstance.delete(key);
          return;
        }

        const hasBufferedOutput = this.bufferedOutputByInstance.has(key);
        if (!hasBufferedOutput) {
          this.finalOnlyQuietFlushPollsByInstance.delete(key);
          return;
        }

        const quietFlushThreshold = Math.max(1, this.quietPendingPollThreshold);
        const nextQuietPolls = (this.finalOnlyQuietFlushPollsByInstance.get(key) || 0) + 1;
        if (nextQuietPolls < quietFlushThreshold) {
          this.finalOnlyQuietFlushPollsByInstance.set(key, nextQuietPolls);
          return;
        }

        await this.flushBufferedOutput(key, channelId, agentType);
        this.finalOnlyQuietFlushPollsByInstance.delete(key);
        return;
      }
      return;
    }

    this.finalOnlyQuietFlushPollsByInstance.delete(key);

    const hasOutputCandidate = this.completionCandidatesByInstance.has(key);
    const codexStillWorking =
      agentType === 'codex' &&
      typeof captureSnapshot === 'string' &&
      this.hasCodexWorkingMarker(captureSnapshot);
    if (codexStillWorking) {
      // Do not auto-complete while Codex still indicates active processing.
      this.quietPendingPollsByInstance.delete(key);
      return;
    }
    if (
      !this.codexFinalOnlyModeEnabled &&
      agentType === 'codex' &&
      hasOutputCandidate &&
      typeof captureSnapshot === 'string' &&
      this.isLikelyCodexReadyForInput(captureSnapshot)
    ) {
      await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceId).catch(() => undefined);
      this.deps.ioTracker?.recordTurnCompleted({
        projectName,
        instanceId,
        channelId,
        reason: 'input-ready-marker',
      });
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      return;
    }

    const quietThreshold = this.resolveQuietCompletionThreshold(hasOutputCandidate, agentType);
    if (quietThreshold <= 0) {
      this.quietPendingPollsByInstance.delete(key);
      return;
    }

    const current = this.quietPendingPollsByInstance.get(key);
    const nextCount = (current?.count || 0) + 1;
    if (nextCount >= quietThreshold) {
      await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceId).catch(() => undefined);
      if (agentType === 'codex') {
        this.deps.ioTracker?.recordTurnCompleted({
          projectName,
          instanceId,
          channelId,
          reason: 'quiet-threshold',
        });
      }
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      return;
    }

    this.quietPendingPollsByInstance.set(key, {
      count: nextCount,
      projectName,
      agentType,
      instanceId,
    });
  }

  private resolveQuietCompletionThreshold(hasOutputCandidate: boolean, agentType: string): number {
    if (hasOutputCandidate) {
      return this.quietPendingPollThreshold;
    }
    if (agentType === 'codex') {
      return this.codexInitialQuietPendingPollThreshold;
    }
    return this.quietPendingPollThreshold;
  }

  private captureKey(projectName: string, instanceId: string): string {
    return `${projectName}::${instanceId}`;
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

  private stripPendingPromptEcho(
    projectName: string,
    agentType: string,
    instanceId: string,
    pendingDepth: number,
    delta: string,
  ): string {
    if (pendingDepth <= 0) return delta;
    if (agentType !== 'codex') return delta;

    const promptNorms = this.getPendingPromptTails(projectName, agentType, instanceId)
      .map((tail) => this.normalizePromptFragment(tail))
      .filter((tail) => tail.length > 0);
    if (promptNorms.length === 0) return delta;

    const lines = delta.split('\n');
    let dropCount = 0;
    const maxScanLines = pendingDepth === 1 ? 16 : 4;

    for (let i = 0; i < Math.min(lines.length, maxScanLines); i += 1) {
      const normalizedLine = this.normalizePromptFragment(lines[i] || '');
      if (normalizedLine.length === 0) {
        dropCount += 1;
        continue;
      }

      if (/^(assistant|system|user)\s*:/i.test(normalizedLine)) break;

      const looksLikePromptEcho =
        pendingDepth === 1
          ? this.isLikelyPromptEchoLine(promptNorms[0]!, normalizedLine)
          : this.isLikelyMultiPendingPromptEchoLine(promptNorms, normalizedLine);
      if (!looksLikePromptEcho) break;
      dropCount += 1;
    }

    if (pendingDepth === 1) {
      for (let end = Math.max(2, dropCount + 1); end <= Math.min(lines.length, maxScanLines); end += 1) {
        const block = this.normalizePromptFragment(lines.slice(0, end).join(' '));
        if (/^(assistant|system|user)\s*:/i.test(block)) break;
        if (!this.isLikelyPromptEchoBlock(promptNorms[0]!, block)) break;
        dropCount = end;
      }
    }

    if (dropCount === 0) return delta;
    return lines.slice(dropCount).join('\n');
  }

  private normalizePromptFragment(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    // Codex renders the input row with a leading prompt marker.
    // Normalize it away so pending echo matching can use raw prompt text.
    return compact.replace(/^›\s+/, '');
  }

  private isLikelyPromptEchoLine(promptNorm: string, normalizedLine: string): boolean {
    if (normalizedLine === promptNorm) return true;
    if (normalizedLine.length < 16) return false;

    // Wrapped terminal echo often appears as a leading/trailing fragment of the
    // submitted prompt. Keep this strict to avoid stripping real assistant text.
    if (promptNorm.startsWith(normalizedLine) && normalizedLine.length >= 24) return true;
    if (promptNorm.endsWith(normalizedLine) && normalizedLine.length >= 24) return true;

    return false;
  }

  private isLikelyPromptEchoBlock(promptNorm: string, normalizedBlock: string): boolean {
    if (normalizedBlock.length === 0) return false;
    if (normalizedBlock === promptNorm) return true;
    if (normalizedBlock.length < 24) return false;

    if (promptNorm.startsWith(normalizedBlock)) return true;
    if (promptNorm.endsWith(normalizedBlock)) return true;
    if (normalizedBlock.length >= 48 && promptNorm.includes(normalizedBlock)) return true;
    return false;
  }

  private isLikelyMultiPendingPromptEchoLine(promptNorms: string[], normalizedLine: string): boolean {
    if (normalizedLine.length < 48) return false;

    return promptNorms.some((promptNorm) => {
      if (normalizedLine === promptNorm) return true;
      return promptNorm.includes(normalizedLine);
    });
  }

  private getPendingPromptTails(projectName: string, agentType: string, instanceId?: string): string[] {
    const pendingTracker = this.deps.pendingTracker as unknown as {
      getPendingPromptTails?: (projectName: string, agentType: string, instanceId?: string) => string[];
      getPendingPromptTail?: (projectName: string, agentType: string, instanceId?: string) => string | undefined;
    };

    if (typeof pendingTracker.getPendingPromptTails === 'function') {
      return pendingTracker.getPendingPromptTails(projectName, agentType, instanceId).filter((tail) => tail.trim().length > 0);
    }

    if (typeof pendingTracker.getPendingPromptTail === 'function') {
      const tail = pendingTracker.getPendingPromptTail(projectName, agentType, instanceId);
      return tail && tail.trim().length > 0 ? [tail] : [];
    }

    return [];
  }

  private extractDelta(agentType: string, previous: string, current: string): string {
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }

    const overlap = this.longestSuffixPrefix(previous, current);
    if (overlap > 0) {
      return current.slice(overlap);
    }

    return this.extractDeltaByLineAnchor(agentType, previous, current);
  }

  private longestSuffixPrefix(left: string, right: string): number {
    const max = Math.min(left.length, right.length);

    for (let len = max; len > 0; len -= 1) {
      if (left.endsWith(right.slice(0, len))) {
        return len;
      }
    }

    return 0;
  }

  private isTailAnchorLikelyUnstableForAgent(
    agentType: string,
    line: string,
    anchorIndex: number,
    totalLines: number,
  ): boolean {
    if (agentType !== 'codex') return false;

    const distanceFromBottom = Math.max(0, totalLines - 1 - anchorIndex);
    // The very last line in Codex is commonly HUD/footer noise.
    if (distanceFromBottom === 0) return true;
    if (distanceFromBottom > 3) return false;

    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;
    if (this.isCodexUiStatusNoiseLine(compact)) return true;
    if (/^esc to interrupt\b/i.test(compact)) return true;
    if (/^›\s+/.test(compact)) return true;

    return false;
  }

  private extractDeltaByLineAnchor(agentType: string, previous: string, current: string): string {
    const prevLines = previous.split('\n');
    const currLines = current.split('\n');
    if (currLines.length === 0) return '';
    let foundTailAnchorOnly = false;

    // Use the most recent stable line from previous snapshot as an anchor.
    for (let i = prevLines.length - 1; i >= 0; i -= 1) {
      const line = prevLines[i];
      if (line.trim().length === 0) continue;
      const anchor = currLines.lastIndexOf(line);
      if (anchor >= 0 && anchor < currLines.length - 1) {
        if (this.isTailAnchorLikelyUnstableForAgent(agentType, line, anchor, currLines.length)) {
          foundTailAnchorOnly = true;
          continue;
        }
        return currLines.slice(anchor + 1).join('\n');
      }
      if (anchor === currLines.length - 1) {
        // For full-screen TUI redraws, the bottom status line often stays
        // identical while content above changes completely. Keep scanning for
        // a better anchor; if we only find tail anchors, fall back to tail.
        foundTailAnchorOnly = true;
        continue;
      }
    }

    if (foundTailAnchorOnly) {
      return currLines.slice(Math.max(0, currLines.length - this.redrawFallbackTailLines)).join('\n');
    }

    // As a last resort for full-screen redraws, send only the tail.
    return currLines.slice(Math.max(0, currLines.length - this.redrawFallbackTailLines)).join('\n');
  }

  private normalizeDeltaForAgent(
    agentType: string,
    delta: string,
    previous: string,
    current: string,
  ): string {
    let normalized = delta;

    if (agentType === 'codex') {
      normalized = this.stripCodexBootstrapNoise(normalized);

      // Full-screen redraws can still look like huge deltas; reduce to tail.
      if (normalized.length > 4000 && !current.startsWith(previous)) {
        const lines = normalized.split('\n');
        normalized = lines.slice(Math.max(0, lines.length - 24)).join('\n');
      }
    }

    return normalized;
  }

  private stripCodexBootstrapNoise(text: string): string {
    const lines = text.split('\n');
    const compactNonEmpty = lines
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0);
    if (this.isLikelyCodexDraftLeak(compactNonEmpty)) {
      return '';
    }

    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (/^export AGENT_DISCORD_[A-Z_]+=/.test(trimmed)) return false;
      if (/^\$?\s*cd\s+".*"\s*&&\s*codex\b/.test(trimmed)) return false;
      // Codex input row echo (e.g. "› Write tests for @filename") is not output.
      if (/^›(?:\s.*)?$/.test(trimmed)) return false;
      if (this.isCodexUiProgressNoiseLine(trimmed)) return false;
      if (this.isCodexUiStatusNoiseLine(trimmed)) return false;
      return true;
    });
    return filtered.join('\n');
  }

  private isLikelyCodexDraftLeak(compactLines: string[]): boolean {
    if (compactLines.length === 0) return false;

    const hasProgressNoise = compactLines.some((line) => this.isCodexUiProgressNoiseLine(line));
    const hasInteractivePromptEcho = compactLines.some((line) => /\bSelect action \[\d+-\d+\]/i.test(line));
    const diffStyleCount = compactLines.filter((line) => this.isCodexDiffLikeLine(line)).length;
    const numberedCodeLikeCount = compactLines.filter((line) => /^\d+\s{2,}\S/.test(line)).length;
    const hasPatchHeader = compactLines.some((line) => /^(diff --git|@@\s|(?:\+\+\+|---)\s)/.test(line));

    if (hasProgressNoise && (diffStyleCount >= 2 || hasInteractivePromptEcho || numberedCodeLikeCount >= 6 || hasPatchHeader)) {
      return true;
    }
    if (hasInteractivePromptEcho && diffStyleCount >= 2 && numberedCodeLikeCount >= 4) {
      return true;
    }
    return false;
  }

  private isCodexDiffLikeLine(line: string): boolean {
    if (/^\d+\s+[+-]\s+/.test(line)) return true;
    if (/^(?:\+\+\+|---)\s+\S/.test(line)) return true;
    if (/^@@\s+/.test(line)) return true;
    if (/^diff --git\b/.test(line)) return true;
    return false;
  }

  private isCodexUiProgressNoiseLine(line: string): boolean {
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return false;

    // Codex often renders transient progress lines while drafting.
    // These are not final user-facing output and should not be bridged.
    if (/^[•·]\s*(crafting|thinking|analyzing|analysis|planning|preparing|reviewing|searching|reading|writing|editing|running|checking|executing|building|debugging|investigating|summarizing|drafting)\b/i.test(compact)) {
      return true;
    }
    if (/^[•·]\s*.+\([0-9smh\s]+\s*[•·]\s*esc to interrupt\)$/i.test(compact)) {
      return true;
    }
    if (/^(?:[•·]\s*)?working\s*\(\d+\s*[smh]\s*[•·]\s*esc to interrupt\)$/i.test(compact)) {
      return true;
    }
    // Strong fallback: any transient UI row that still contains this marker
    // should be filtered, except explicit role-prefixed model messages.
    if (/\besc to interrupt\b/i.test(compact) && !/^(assistant|system|user)\s*:/i.test(compact)) {
      return true;
    }
    if (/^esc to interrupt\b/i.test(compact)) return true;
    return false;
  }

  private isCodexUiStatusNoiseLine(line: string): boolean {
    // Codex TUI footer noise can be wrapped/truncated while percentages change.
    // Examples:
    //   "? for shortcuts ... 95% context left"
    //   "rfor shortcuts t ... 94% context left"
    //   "95% context left"
    //   "gpt-5.3-codex xhigh · 99% left · ~/repo/path"
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;

    const hasShortcuts = /for shortcuts/i.test(compact);
    const hasContextPct = /\b\d{1,3}%\s*context left\b/i.test(compact);
    if (hasShortcuts && hasContextPct) return true;

    if (/^\d{1,3}%\s*context left$/i.test(compact)) return true;
    if (/^\??\s*for shortcuts$/i.test(compact)) return true;
    if (/^tab to queue message(?:\s+\d{1,3}%\s*(?:context\s*)?left)?$/i.test(compact)) return true;
    if (/^.+[·•]\s*\d{1,3}%\s*left\s*[·•]\s*(?:~\/|\/).+$/i.test(compact)) return true;

    return false;
  }
}
