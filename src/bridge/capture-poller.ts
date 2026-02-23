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
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private snapshotsByInstance = new Map<string, string>();

  constructor(private deps: BridgeCapturePollerDeps) {
    this.intervalMs = this.resolveIntervalMs(deps.intervalMs);
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
          if (!current || current.trim().length === 0) continue;

          const key = this.captureKey(project.projectName, instance.instanceId);
          const previous = this.snapshotsByInstance.get(key);
          this.snapshotsByInstance.set(key, current);

          // First snapshot establishes baseline and avoids sending historical backlog.
          if (previous === undefined) continue;
          if (previous === current) continue;

          const delta = this.normalizeDeltaForAgent(
            instance.agentType,
            this.extractDelta(previous, current),
            previous,
            current,
          ).trim();
          if (delta.length === 0) continue;

          // For non-hook agents, any fresh output is our completion signal.
          await this.deps.pendingTracker
            .markCompleted(project.projectName, instance.agentType, instance.instanceId)
            .catch(() => undefined);

          const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
          for (const chunk of split(delta)) {
            if (chunk.trim().length === 0) continue;
            await this.deps.messaging.sendToChannel(instance.channelId, chunk);
          }
        }
      }
    } catch (error) {
      console.warn(`Capture poller iteration failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private captureKey(projectName: string, instanceId: string): string {
    return `${projectName}::${instanceId}`;
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
      return true;
    });
    return filtered.join('\n');
  }
}
