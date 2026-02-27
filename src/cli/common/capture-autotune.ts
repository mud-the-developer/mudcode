import type { ProjectState } from '../../types/index.js';
import { config, getConfigValue, saveConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { listProjectInstances, normalizeProjectState } from '../../state/instances.js';
import { TmuxManager } from '../../tmux/manager.js';
import { cleanCapture } from '../../capture/parser.js';

export type CaptureTuning = {
  historyLines: number;
  redrawTailLines: number;
};

export type CaptureAutoTuneResult = {
  scannedInstances: number;
  activeInstances: number;
  maxObservedLines: number;
  tuning: CaptureTuning;
  changed: boolean;
};

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function recommendCaptureTuning(maxObservedLines: number, platform: NodeJS.Platform = process.platform): CaptureTuning {
  const lines = Math.max(0, Math.trunc(maxObservedLines));

  // When there is no active pane to probe, keep a conservative platform default.
  if (lines <= 0) {
    if (platform === 'linux') {
      return { historyLines: 1200, redrawTailLines: 100 };
    }
    return { historyLines: 800, redrawTailLines: 80 };
  }

  if (lines >= 1800) return { historyLines: 3200, redrawTailLines: 180 };
  if (lines >= 1200) return { historyLines: 2400, redrawTailLines: 140 };
  if (lines >= 800) return { historyLines: 1800, redrawTailLines: 120 };
  if (lines >= 400) return { historyLines: 1200, redrawTailLines: 100 };
  return { historyLines: 800, redrawTailLines: 80 };
}

function resolveWindowName(project: ProjectState, instanceId: string): string {
  const normalized = normalizeProjectState(project);
  const instance = normalized.instances?.[instanceId];
  if (instance?.tmuxWindow && instance.tmuxWindow.trim().length > 0) {
    return instance.tmuxWindow;
  }
  return instanceId;
}

export function autoTuneCaptureSettings(): CaptureAutoTuneResult {
  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const projects = stateManager.listProjects();

  let scannedInstances = 0;
  let activeInstances = 0;
  let maxObservedLines = 0;

  for (const rawProject of projects) {
    const project = normalizeProjectState(rawProject);
    for (const instance of listProjectInstances(project)) {
      scannedInstances += 1;
      const windowName = resolveWindowName(project, instance.instanceId);
      if (!windowName) continue;
      if (!tmux.sessionExistsFull(project.tmuxSession)) continue;
      if (!tmux.windowExists(project.tmuxSession, windowName)) continue;

      let captureRaw = '';
      try {
        captureRaw = tmux.capturePaneFromWindow(project.tmuxSession, windowName, instance.agentType);
      } catch {
        continue;
      }

      const cleaned = cleanCapture(captureRaw);
      const lineCount = cleaned.length > 0 ? cleaned.split('\n').length : 0;
      activeInstances += 1;
      if (lineCount > maxObservedLines) {
        maxObservedLines = lineCount;
      }
    }
  }

  const recommended = recommendCaptureTuning(maxObservedLines);
  const recommendedHistoryLines = clampInt(recommended.historyLines, 300, 4000);
  const recommendedRedrawTailLines = clampInt(recommended.redrawTailLines, 40, 300);

  const storedHistoryLinesRaw = getConfigValue('captureHistoryLines');
  const storedRedrawTailLinesRaw = getConfigValue('captureRedrawTailLines');
  const storedHistoryLines = Number(storedHistoryLinesRaw);
  const storedRedrawTailLines = Number(storedRedrawTailLinesRaw);

  // Respect explicit config values if present; only auto-fill missing fields.
  const historyPinned =
    Number.isFinite(storedHistoryLines) &&
    Number.isInteger(storedHistoryLines) &&
    storedHistoryLines >= 300 &&
    storedHistoryLines <= 4000;
  const redrawPinned =
    Number.isFinite(storedRedrawTailLines) &&
    Number.isInteger(storedRedrawTailLines) &&
    storedRedrawTailLines >= 40 &&
    storedRedrawTailLines <= 300;

  const historyLines = historyPinned ? storedHistoryLines : recommendedHistoryLines;
  const redrawTailLines = redrawPinned ? storedRedrawTailLines : recommendedRedrawTailLines;

  const currentHistoryLines = historyPinned ? storedHistoryLines : 0;
  const currentRedrawTailLines = redrawPinned ? storedRedrawTailLines : 0;
  const changed = currentHistoryLines !== historyLines || currentRedrawTailLines !== redrawTailLines;

  if (changed) {
    saveConfig({
      captureHistoryLines: historyLines,
      captureRedrawTailLines: redrawTailLines,
    });
  }

  return {
    scannedInstances,
    activeInstances,
    maxObservedLines,
    tuning: {
      historyLines,
      redrawTailLines,
    },
    changed,
  };
}
