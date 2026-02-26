import { cleanCapture, splitForDiscord, splitForSlack } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import { listProjectInstances, normalizeProjectState } from '../state/instances.js';
import { TmuxManager } from '../tmux/manager.js';
import type { IStateManager } from '../types/interfaces.js';
import { PendingMessageTracker } from './pending-message-tracker.js';

export interface BridgeCapturePollerDeps {
  messaging: MessagingClient;
  tmux: TmuxManager;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  intervalMs?: number;
}

export class BridgeCapturePoller {
  private readonly intervalMs: number;
  private readonly quietPendingPollThreshold: number;
  private readonly codexInitialQuietPendingPollThreshold: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private snapshotsByInstance = new Map<string, string>();
  private completionCandidatesByInstance = new Map<
    string,
    { projectName: string; agentType: string; instanceId: string }
  >();
  private quietPendingPollsByInstance = new Map<
    string,
    { count: number; projectName: string; agentType: string; instanceId: string }
  >();

  constructor(private deps: BridgeCapturePollerDeps) {
    this.intervalMs = this.resolveIntervalMs(deps.intervalMs);
    this.quietPendingPollThreshold = this.resolveQuietPendingPollThreshold();
    this.codexInitialQuietPendingPollThreshold = this.resolveCodexInitialQuietPendingPollThreshold();
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
    this.completionCandidatesByInstance.clear();
    this.quietPendingPollsByInstance.clear();
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

  private resolveQuietPendingPollThreshold(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1) {
      return Math.trunc(fromEnv);
    }
    return 2;
  }

  private resolveCodexInitialQuietPendingPollThreshold(): number {
    const fromEnv = Number(process.env.AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX || '');
    if (Number.isFinite(fromEnv) && fromEnv >= 1) {
      return Math.trunc(fromEnv);
    }
    // Keep typing/reaction pending state longer before first visible output.
    // With default 3s polling, this is about 36 seconds.
    return 12;
  }

  private async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const keysWithOutputThisCycle = new Set<string>();
      const projects = this.deps.stateManager.listProjects();
      for (const rawProject of projects) {
        const project = normalizeProjectState(rawProject);
        const instances = listProjectInstances(project);

        for (const instance of instances) {
          if (instance.eventHook) continue;
          if (!instance.channelId) continue;

          const key = this.captureKey(project.projectName, instance.instanceId);
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
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
            );
            continue;
          }

          const previous = this.snapshotsByInstance.get(key);
          this.snapshotsByInstance.set(key, current);

          // First snapshot establishes baseline and avoids sending historical backlog.
          if (previous === undefined || previous === current) {
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
            );
            continue;
          }

          const delta = this.normalizeDeltaForAgent(
            instance.agentType,
            this.extractDelta(previous, current),
            previous,
            current,
          );
          const normalizedForPendingPrompt = this.stripPendingPromptEcho(
            project.projectName,
            instance.agentType,
            instance.instanceId,
            routeInfo.pendingDepth,
            delta,
          );
          const trimmedDelta = normalizedForPendingPrompt.trim();
          if (trimmedDelta.length === 0) {
            const suppressedByPromptEcho = delta.trim().length > 0;
            if (suppressedByPromptEcho) {
              // Treat prompt-echo-only frames as activity. If we count them as quiet,
              // pending requests can complete before real assistant output arrives.
              this.quietPendingPollsByInstance.delete(key);
              if (routeInfo.pendingDepth > 0) {
                keysWithOutputThisCycle.add(key);
              }
              continue;
            }
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
            );
            continue;
          }

          const outputChannelId = routeInfo.channelId;
          if (!outputChannelId) continue;

          const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
          let sentAnyChunk = false;
          for (const chunk of split(trimmedDelta)) {
            if (chunk.trim().length === 0) continue;
            await this.deps.messaging.sendToChannel(outputChannelId, chunk);
            sentAnyChunk = true;
          }

          if (sentAnyChunk) {
            this.quietPendingPollsByInstance.delete(key);
            if (routeInfo.pendingDepth > 0) {
              // Keep completion buffered until output goes quiet. Completing on every burst can
              // over-advance the queue during long multi-cycle responses.
              keysWithOutputThisCycle.add(key);
              this.completionCandidatesByInstance.set(key, {
                projectName: project.projectName,
                agentType: instance.agentType,
                instanceId: instance.instanceId,
              });
            } else {
              this.completionCandidatesByInstance.delete(key);
            }
          } else {
            await this.handleQuietPending(
              key,
              routeInfo.pendingDepth,
              project.projectName,
              instance.agentType,
              instance.instanceId,
            );
          }
        }
      }

      await this.completeQuietPendingInstances(keysWithOutputThisCycle);
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
  ): Promise<void> {
    if (pendingDepth <= 0) {
      this.quietPendingPollsByInstance.delete(key);
      this.completionCandidatesByInstance.delete(key);
      return;
    }

    const hasOutputCandidate = this.completionCandidatesByInstance.has(key);
    const quietThreshold =
      !hasOutputCandidate && agentType === 'codex'
        ? this.codexInitialQuietPendingPollThreshold
        : this.quietPendingPollThreshold;

    const current = this.quietPendingPollsByInstance.get(key);
    const nextCount = (current?.count || 0) + 1;
    if (nextCount >= quietThreshold) {
      await this.deps.pendingTracker.markCompleted(projectName, agentType, instanceId).catch(() => undefined);
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

  private async completeQuietPendingInstances(keysWithOutputThisCycle: Set<string>): Promise<void> {
    for (const [key, candidate] of this.completionCandidatesByInstance.entries()) {
      if (keysWithOutputThisCycle.has(key)) continue;
      await this.deps.pendingTracker
        .markCompleted(candidate.projectName, candidate.agentType, candidate.instanceId)
        .catch(() => undefined);
      this.completionCandidatesByInstance.delete(key);
    }
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
      .filter((tail) => tail.length >= 16);
    if (promptNorms.length === 0) return delta;

    const lines = delta.split('\n');
    let dropCount = 0;
    const maxScanLines = pendingDepth === 1 ? 8 : 2;

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

    if (dropCount === 0) return delta;
    return lines.slice(dropCount).join('\n');
  }

  private normalizePromptFragment(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  private isLikelyPromptEchoLine(promptNorm: string, normalizedLine: string): boolean {
    if (normalizedLine.length < 16) return false;
    if (normalizedLine === promptNorm) return true;

    // Wrapped terminal echo often appears as a leading/trailing fragment of the
    // submitted prompt. Keep this strict to avoid stripping real assistant text.
    if (promptNorm.startsWith(normalizedLine) && normalizedLine.length >= 24) return true;
    if (promptNorm.endsWith(normalizedLine) && normalizedLine.length >= 24) return true;

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

  private extractDelta(previous: string, current: string): string {
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }

    const overlap = this.longestSuffixPrefix(previous, current);
    if (overlap > 0) {
      return current.slice(overlap);
    }

    return this.extractDeltaByLineAnchor(previous, current);
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

  private extractDeltaByLineAnchor(previous: string, current: string): string {
    const prevLines = previous.split('\n');
    const currLines = current.split('\n');
    if (currLines.length === 0) return '';

    // Use the most recent stable line from previous snapshot as an anchor.
    for (let i = prevLines.length - 1; i >= 0; i -= 1) {
      const line = prevLines[i];
      if (line.trim().length === 0) continue;
      const anchor = currLines.lastIndexOf(line);
      if (anchor >= 0 && anchor < currLines.length - 1) {
        return currLines.slice(anchor + 1).join('\n');
      }
      if (anchor === currLines.length - 1) {
        return '';
      }
    }

    // As a last resort for full-screen redraws, send only the tail.
    return currLines.slice(Math.max(0, currLines.length - 20)).join('\n');
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
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (/^export AGENT_DISCORD_[A-Z_]+=/.test(trimmed)) return false;
      if (/^\$?\s*cd\s+".*"\s*&&\s*codex\b/.test(trimmed)) return false;
      if (this.isCodexUiStatusNoiseLine(trimmed)) return false;
      return true;
    });
    return filtered.join('\n');
  }

  private isCodexUiStatusNoiseLine(line: string): boolean {
    // Codex TUI footer noise can be wrapped/truncated while percentages change.
    // Examples:
    //   "? for shortcuts ... 95% context left"
    //   "rfor shortcuts t ... 94% context left"
    //   "95% context left"
    const compact = line.replace(/\s+/g, ' ').trim();
    if (compact.length === 0) return true;

    const hasShortcuts = /for shortcuts/i.test(compact);
    const hasContextPct = /\b\d{1,3}%\s*context left\b/i.test(compact);
    if (hasShortcuts && hasContextPct) return true;

    if (/^\d{1,3}%\s*context left$/i.test(compact)) return true;
    if (/^\??\s*for shortcuts$/i.test(compact)) return true;

    return false;
  }
}
