import chalk from 'chalk';
import { config, getConfigPath, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { listProjectInstances } from '../../state/instances.js';
import { createTmuxManager } from '../../tmux/factory.js';
import type { TmuxManager } from '../../tmux/manager.js';
import { getDaemonStatus } from '../../app/daemon-service.js';
import { resolveProjectWindowName } from '../../policy/window-naming.js';
import { applyTmuxCliOverrides } from '../common/tmux.js';
import type { TmuxCliOptions } from '../common/types.js';
import { cleanCapture } from '../../capture/parser.js';

type HealthLevel = 'ok' | 'warn' | 'fail';

type HealthCheck = {
  name: string;
  level: HealthLevel;
  detail: string;
};

type InstanceHealth = {
  projectName: string;
  instanceId: string;
  agentType: string;
  tmuxSession: string;
  tmuxWindow: string;
  sessionExists: boolean;
  windowExists: boolean;
  channelId: string | undefined;
  runtime?: RuntimeSnapshot;
  paneWorkingHint?: boolean;
  captureProbe?: CaptureProbeSnapshot;
};

type RuntimeSnapshot = {
  pendingDepth: number;
  oldestStage?: string;
  oldestAgeMs?: number;
  oldestUpdatedAt?: string;
  latestStage?: string;
  latestAgeMs?: number;
  latestUpdatedAt?: string;
  lastTerminalStage?: 'completed' | 'error' | 'retry';
  lastTerminalAgeMs?: number;
  lastTerminalAt?: string;
  ignoredEventCount?: number;
  ignoredEventTypes?: Record<string, number>;
  ignoredLastAt?: string;
  lifecycleRejectedEventCount?: number;
  lifecycleRejectedEventTypes?: Record<string, number>;
  lifecycleRejectedLastAt?: string;
  eventProgressMode?: 'off' | 'thread' | 'channel';
  eventProgressModeTurnId?: string;
  eventProgressModeUpdatedAt?: string;
  eventProgressModeAgeMs?: number;
};

type RuntimeStatusEntry = RuntimeSnapshot & {
  projectName: string;
  instanceId: string;
  agentType: string;
};

type RuntimeStatusPayload = {
  generatedAt?: string;
  instances?: RuntimeStatusEntry[];
};

type CaptureProbeStatus = 'ok' | 'warn' | 'fail';

type CaptureProbeSnapshot = {
  enabled: true;
  polls: number;
  intervalMs: number;
  captures: number;
  changes: number;
  emptyCaptures: number;
  maxLines: number;
  lastLines: number;
  status: CaptureProbeStatus;
  detail: string;
  lastError?: string;
};

function pushCheck(checks: HealthCheck[], name: string, level: HealthLevel, detail: string): void {
  checks.push({ name, level, detail });
}

function runtimeKey(projectName: string, instanceId: string): string {
  return `${projectName}:${instanceId}`;
}

function parseRuntimeProgressMode(raw: unknown): 'off' | 'thread' | 'channel' | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
    return normalized;
  }
  return undefined;
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseProgressModeFromEnv(raw: string | undefined): 'off' | 'thread' | 'channel' | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
    return normalized;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'thread';
  if (['0', 'false', 'no'].includes(normalized)) return 'off';
  return undefined;
}

function resolveCodexEventOnlyEnabled(): boolean {
  return parseBoolEnv(process.env.AGENT_DISCORD_CODEX_EVENT_ONLY) === true;
}

function resolveExpectedCodexProgressMode(): 'off' | 'thread' | 'channel' | undefined {
  const direct = parseProgressModeFromEnv(process.env.AGENT_DISCORD_CODEX_EVENT_PROGRESS_MODE);
  if (direct) return direct;
  return parseProgressModeFromEnv(process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD);
}

function resolveProgressModeStaleWarnMs(): number {
  const fromEnv = Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 5000 && fromEnv <= 3_600_000) {
    return Math.trunc(fromEnv);
  }
  return 90_000;
}

function formatRuntimeAge(ageMs?: number): string {
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  if (ageMs < 1000) return '<1s';
  const sec = Math.round(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.round(min / 60);
  return `${hour}h`;
}

function resolveCaptureProbePolls(raw?: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 1 && n <= 20) return n;
  }
  return 4;
}

function resolveCaptureProbeIntervalMs(raw?: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.trunc(raw);
    if (n >= 300 && n <= 10000) return n;
  }
  return 1200;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureProbeKey(instance: InstanceHealth): string {
  return `${instance.projectName}:${instance.instanceId}`;
}

async function runCaptureProbe(
  tmux: TmuxManager,
  instances: InstanceHealth[],
  polls: number,
  intervalMs: number,
): Promise<Map<string, CaptureProbeSnapshot>> {
  type ProbeMutableState = {
    previous?: string;
    captures: number;
    changes: number;
    emptyCaptures: number;
    maxLines: number;
    lastLines: number;
    lastError?: string;
  };

  const states = new Map<string, ProbeMutableState>();
  for (const instance of instances) {
    states.set(captureProbeKey(instance), {
      captures: 0,
      changes: 0,
      emptyCaptures: 0,
      maxLines: 0,
      lastLines: 0,
    });
  }

  const sampleOnce = (): void => {
    for (const instance of instances) {
      const key = captureProbeKey(instance);
      const state = states.get(key);
      if (!state) continue;
      if (!instance.windowExists) continue;

      try {
        const captureRaw = tmux.capturePaneFromWindow(instance.tmuxSession, instance.tmuxWindow, instance.agentType);
        const cleaned = cleanCapture(captureRaw);
        const lineCount = cleaned.length > 0 ? cleaned.split('\n').length : 0;
        state.captures += 1;
        state.lastLines = lineCount;
        state.maxLines = Math.max(state.maxLines, lineCount);
        if (cleaned.trim().length === 0) state.emptyCaptures += 1;
        if (typeof state.previous === 'string' && state.previous !== cleaned) {
          state.changes += 1;
        }
        state.previous = cleaned;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    }
  };

  sampleOnce();
  for (let i = 1; i < polls; i += 1) {
    await sleep(intervalMs);
    sampleOnce();
  }

  const result = new Map<string, CaptureProbeSnapshot>();
  for (const instance of instances) {
    const key = captureProbeKey(instance);
    const state = states.get(key);
    if (!state) continue;

    let status: CaptureProbeStatus = 'ok';
    let detail = `captures=${state.captures}, changes=${state.changes}, lines=${state.lastLines}, max=${state.maxLines}`;
    const pendingDepth = instance.runtime?.pendingDepth || 0;

    if (!instance.windowExists) {
      status = 'warn';
      detail = 'skipped (tmux window missing)';
    } else if (state.captures === 0) {
      status = 'fail';
      detail = state.lastError ? `capture failed: ${state.lastError}` : 'no captures collected';
    } else if (state.emptyCaptures === state.captures) {
      status = 'warn';
      detail = `all captures were empty (${state.captures}/${state.captures})`;
    } else if (pendingDepth > 0 && state.changes === 0) {
      status = 'warn';
      detail = instance.paneWorkingHint
        ? `pending=${pendingDepth}, pane says working, but no screen deltas in ${polls} poll(s)`
        : `pending=${pendingDepth}, but no screen deltas in ${polls} poll(s)`;
    }

    result.set(key, {
      enabled: true,
      polls,
      intervalMs,
      captures: state.captures,
      changes: state.changes,
      emptyCaptures: state.emptyCaptures,
      maxLines: state.maxLines,
      lastLines: state.lastLines,
      status,
      detail,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    });
  }

  return result;
}

function hasEscToInterruptMarker(captureRaw: string): boolean {
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

function detectPaneWorkingHint(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  agentType: string,
): boolean {
  if (agentType !== 'codex') return false;
  try {
    const pane = tmux.capturePaneFromWindow(sessionName, windowName, agentType);
    return hasEscToInterruptMarker(pane);
  } catch {
    return false;
  }
}

function describeRuntime(runtime?: RuntimeSnapshot, paneWorkingHint: boolean = false): string {
  const ignoredCount =
    typeof runtime?.ignoredEventCount === 'number' && Number.isFinite(runtime.ignoredEventCount)
      ? Math.max(0, Math.trunc(runtime.ignoredEventCount))
      : 0;
  const rejectedCount =
    typeof runtime?.lifecycleRejectedEventCount === 'number' && Number.isFinite(runtime.lifecycleRejectedEventCount)
      ? Math.max(0, Math.trunc(runtime.lifecycleRejectedEventCount))
      : 0;
  const ignoredSuffix = ignoredCount > 0 ? `, ignored hook events=${ignoredCount}` : '';
  const rejectedSuffix = rejectedCount > 0 ? `, lifecycle rejects=${rejectedCount}` : '';
  const progressModeSuffix = runtime?.eventProgressMode
    ? `, progressMode=${runtime.eventProgressMode}` +
      (runtime.eventProgressModeTurnId ? `(${runtime.eventProgressModeTurnId})` : '')
    : '';
  const contractSuffix = `${ignoredSuffix}${rejectedSuffix}${progressModeSuffix}`;

  if (paneWorkingHint) return `working (pane shows "Esc to interrupt"${contractSuffix})`;
  if (!runtime) return 'unavailable';
  if (runtime.pendingDepth > 0) {
    const stage = runtime.oldestStage || runtime.latestStage || 'received';
    return `working (${runtime.pendingDepth} queued, stage=${stage}, age=${formatRuntimeAge(runtime.oldestAgeMs)}${contractSuffix})`;
  }
  if (runtime.lastTerminalStage === 'completed') {
    return `completed recently (${formatRuntimeAge(runtime.lastTerminalAgeMs)} ago${contractSuffix})`;
  }
  if (runtime.lastTerminalStage === 'error') {
    return `last request failed (${formatRuntimeAge(runtime.lastTerminalAgeMs)} ago${contractSuffix})`;
  }
  if (runtime.lastTerminalStage === 'retry') {
    return `last request needs retry (${formatRuntimeAge(runtime.lastTerminalAgeMs)} ago${contractSuffix})`;
  }
  return `idle${contractSuffix}`;
}

async function fetchRuntimeStatus(port: number): Promise<Map<string, RuntimeSnapshot>> {
  const response = await fetch(`http://127.0.0.1:${port}/runtime-status`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`runtime endpoint returned ${response.status}`);
  }

  const payload = (await response.json()) as RuntimeStatusPayload;
  const entries = Array.isArray(payload.instances) ? payload.instances : [];
  const map = new Map<string, RuntimeSnapshot>();
  for (const entry of entries) {
    if (!entry || typeof entry.projectName !== 'string' || typeof entry.instanceId !== 'string') continue;
    map.set(runtimeKey(entry.projectName, entry.instanceId), {
      pendingDepth: Number.isFinite(entry.pendingDepth) ? Math.max(0, Math.trunc(entry.pendingDepth)) : 0,
      oldestStage: entry.oldestStage,
      oldestAgeMs: entry.oldestAgeMs,
      oldestUpdatedAt: entry.oldestUpdatedAt,
      latestStage: entry.latestStage,
      latestAgeMs: entry.latestAgeMs,
      latestUpdatedAt: entry.latestUpdatedAt,
      lastTerminalStage: entry.lastTerminalStage,
      lastTerminalAgeMs: entry.lastTerminalAgeMs,
      lastTerminalAt: entry.lastTerminalAt,
      ignoredEventCount:
        typeof entry.ignoredEventCount === 'number' && Number.isFinite(entry.ignoredEventCount)
          ? Math.max(0, Math.trunc(entry.ignoredEventCount))
          : undefined,
      ignoredEventTypes:
        entry.ignoredEventTypes && typeof entry.ignoredEventTypes === 'object'
          ? (entry.ignoredEventTypes as Record<string, number>)
          : undefined,
      ignoredLastAt: typeof entry.ignoredLastAt === 'string' ? entry.ignoredLastAt : undefined,
      lifecycleRejectedEventCount:
        typeof entry.lifecycleRejectedEventCount === 'number' && Number.isFinite(entry.lifecycleRejectedEventCount)
          ? Math.max(0, Math.trunc(entry.lifecycleRejectedEventCount))
          : undefined,
      lifecycleRejectedEventTypes:
        entry.lifecycleRejectedEventTypes && typeof entry.lifecycleRejectedEventTypes === 'object'
          ? (entry.lifecycleRejectedEventTypes as Record<string, number>)
          : undefined,
      lifecycleRejectedLastAt:
        typeof entry.lifecycleRejectedLastAt === 'string' ? entry.lifecycleRejectedLastAt : undefined,
      eventProgressMode: parseRuntimeProgressMode(entry.eventProgressMode),
      eventProgressModeTurnId:
        typeof entry.eventProgressModeTurnId === 'string' ? entry.eventProgressModeTurnId : undefined,
      eventProgressModeUpdatedAt:
        typeof entry.eventProgressModeUpdatedAt === 'string' ? entry.eventProgressModeUpdatedAt : undefined,
      eventProgressModeAgeMs:
        typeof entry.eventProgressModeAgeMs === 'number' && Number.isFinite(entry.eventProgressModeAgeMs)
          ? Math.max(0, Math.trunc(entry.eventProgressModeAgeMs))
          : undefined,
    });
  }
  return map;
}

export async function healthCommand(
  options: TmuxCliOptions & {
    json?: boolean;
    captureTest?: boolean;
    captureTestPolls?: number;
    captureTestIntervalMs?: number;
  } = {},
): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const tmux = createTmuxManager(effectiveConfig);

  const checks: HealthCheck[] = [];
  const instances: InstanceHealth[] = [];
  let daemonRunning = false;
  const runtimeByInstance = new Map<string, RuntimeSnapshot>();
  const codexEventOnlyEnabled = resolveCodexEventOnlyEnabled();
  const expectedCodexProgressMode = resolveExpectedCodexProgressMode();
  const progressModeStaleWarnMs = resolveProgressModeStaleWarnMs();

  try {
    validateConfig();
    pushCheck(checks, 'config', 'ok', `config valid (${getConfigPath()})`);
  } catch (error) {
    pushCheck(
      checks,
      'config',
      'fail',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const daemon = await getDaemonStatus();
    daemonRunning = daemon.running;
    const daemonDetail = daemon.running
      ? `running on ${daemon.port} (pid file: ${daemon.pidFile})`
      : `not running (expected port ${daemon.port}, pid file: ${daemon.pidFile})`;
    pushCheck(checks, 'daemon', daemon.running ? 'ok' : 'warn', daemonDetail);
  } catch (error) {
    pushCheck(checks, 'daemon', 'fail', error instanceof Error ? error.message : String(error));
  }

  if (daemonRunning) {
    try {
      const runtime = await fetchRuntimeStatus(effectiveConfig.hookServerPort || 18470);
      for (const [key, value] of runtime.entries()) {
        runtimeByInstance.set(key, value);
      }
      pushCheck(checks, 'runtime', 'ok', `loaded runtime status for ${runtime.size} instance(s)`);
    } catch (error) {
      pushCheck(checks, 'runtime', 'warn', `runtime status unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    pushCheck(checks, 'runtime', 'warn', 'daemon not running; runtime status unavailable');
  }

  const projects = stateManager.listProjects();
  if (projects.length === 0) {
    pushCheck(checks, 'projects', 'warn', 'no configured projects');
  } else {
    pushCheck(checks, 'projects', 'ok', `${projects.length} configured project(s)`);
  }

  for (const project of projects) {
    const sessionExists = tmux.sessionExistsFull(project.tmuxSession);
    if (!sessionExists) {
      pushCheck(
        checks,
        `tmux:${project.projectName}`,
        'warn',
        `session missing: ${project.tmuxSession}`,
      );
    }

    const projectInstances = listProjectInstances(project);
    if (projectInstances.length === 0) {
      pushCheck(checks, `project:${project.projectName}`, 'warn', 'no agent instances');
      continue;
    }

    for (const instance of projectInstances) {
      const windowName = resolveProjectWindowName(
        project,
        instance.agentType,
        effectiveConfig.tmux,
        instance.instanceId,
      );
      const windowExists = sessionExists && tmux.windowExists(project.tmuxSession, windowName);
      const channelId = instance.channelId;
      const paneWorkingHint =
        windowExists && detectPaneWorkingHint(tmux, project.tmuxSession, windowName, instance.agentType);
      const runtime = runtimeByInstance.get(runtimeKey(project.projectName, instance.instanceId));
      instances.push({
        projectName: project.projectName,
        instanceId: instance.instanceId,
        agentType: instance.agentType,
        tmuxSession: project.tmuxSession,
        tmuxWindow: windowName,
        sessionExists,
        windowExists,
        channelId,
        runtime,
        paneWorkingHint,
      });

      if (!windowExists) {
        pushCheck(
          checks,
          `instance:${project.projectName}/${instance.instanceId}`,
          'warn',
          `tmux window missing: ${project.tmuxSession}:${windowName}`,
        );
      }
      if (!channelId) {
        pushCheck(
          checks,
          `instance:${project.projectName}/${instance.instanceId}`,
          'fail',
          'channel mapping missing',
        );
      }
      const ignoredEventCount = runtime?.ignoredEventCount || 0;
      if (ignoredEventCount > 0) {
        pushCheck(
          checks,
          `hook:${project.projectName}/${instance.instanceId}`,
          'warn',
          `ignored ${ignoredEventCount} event-hook payload(s) for capture-driven instance`,
        );
      }
      const rejectedEventCount = runtime?.lifecycleRejectedEventCount || 0;
      if (rejectedEventCount > 0) {
        pushCheck(
          checks,
          `contract:${project.projectName}/${instance.instanceId}`,
          'warn',
          `strict lifecycle rejected ${rejectedEventCount} event(s) for this instance`,
        );
      }
      if (instance.agentType === 'codex' && codexEventOnlyEnabled) {
        if (runtime?.eventProgressMode === 'channel') {
          pushCheck(
            checks,
            `contract:${project.projectName}/${instance.instanceId}`,
            'warn',
            'event-only mode detected progressMode=channel; consider thread/off to avoid intermediary channel output',
          );
        }
        if (
          expectedCodexProgressMode &&
          runtime?.eventProgressMode &&
          runtime.eventProgressMode !== expectedCodexProgressMode
        ) {
          pushCheck(
            checks,
            `contract:${project.projectName}/${instance.instanceId}`,
            'warn',
            `runtime progressMode=${runtime.eventProgressMode} differs from expected=${expectedCodexProgressMode}`,
          );
        }
      }
      if (
        instance.agentType === 'codex' &&
        (runtime?.pendingDepth || 0) > 0 &&
        typeof runtime?.eventProgressModeAgeMs === 'number' &&
        runtime.eventProgressModeAgeMs > progressModeStaleWarnMs
      ) {
        pushCheck(
          checks,
          `contract:${project.projectName}/${instance.instanceId}`,
          'warn',
          `progress mode signal stale for ${formatRuntimeAge(runtime.eventProgressModeAgeMs)} (pending=${runtime.pendingDepth})`,
        );
      }
    }
  }

  if (options.captureTest) {
    const probePolls = resolveCaptureProbePolls(options.captureTestPolls);
    const probeIntervalMs = resolveCaptureProbeIntervalMs(options.captureTestIntervalMs);
    const probeByInstance = await runCaptureProbe(tmux, instances, probePolls, probeIntervalMs);
    pushCheck(checks, 'capture-probe', 'ok', `sampled ${instances.length} instance(s), polls=${probePolls}, interval=${probeIntervalMs}ms`);

    for (const instance of instances) {
      const key = captureProbeKey(instance);
      const probe = probeByInstance.get(key);
      if (!probe) continue;
      instance.captureProbe = probe;
      if (probe.status === 'warn') {
        pushCheck(checks, `capture:${instance.projectName}/${instance.instanceId}`, 'warn', probe.detail);
      } else if (probe.status === 'fail') {
        pushCheck(checks, `capture:${instance.projectName}/${instance.instanceId}`, 'fail', probe.detail);
      }
    }
  }

  const summary = {
    ok: checks.filter((check) => check.level === 'ok').length,
    warn: checks.filter((check) => check.level === 'warn').length,
    fail: checks.filter((check) => check.level === 'fail').length,
  };

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary,
          checks,
          instances,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(chalk.cyan('\n🩺 Mudcode Health\n'));
    console.log(chalk.gray(`Config file: ${getConfigPath()}`));
    console.log(chalk.gray(`Platform: ${effectiveConfig.messagingPlatform || 'discord'}`));
    console.log(chalk.gray(`Hook port: ${effectiveConfig.hookServerPort || 18470}`));
    if (options.captureTest) {
      const probePolls = resolveCaptureProbePolls(options.captureTestPolls);
      const probeIntervalMs = resolveCaptureProbeIntervalMs(options.captureTestIntervalMs);
      console.log(chalk.gray(`Capture probe: enabled (${probePolls} polls, ${probeIntervalMs}ms interval)`));
    }
    console.log('');

    for (const check of checks) {
      const icon = check.level === 'ok' ? '✅' : check.level === 'warn' ? '⚠️' : '❌';
      const color = check.level === 'ok' ? chalk.green : check.level === 'warn' ? chalk.yellow : chalk.red;
      console.log(color(`${icon} ${check.name}: ${check.detail}`));
    }

    if (instances.length > 0) {
      console.log(chalk.cyan('\nInstances:\n'));
      for (const instance of instances) {
        const tmuxStatus = instance.windowExists ? chalk.green('ok') : chalk.yellow('missing');
        const channelStatus = instance.channelId ? chalk.green('ok') : chalk.red('missing');
        console.log(
          chalk.gray(
            `- ${instance.projectName}/${instance.instanceId} (${instance.agentType})`,
          ),
        );
        console.log(
          chalk.gray(`    tmux: ${instance.tmuxSession}:${instance.tmuxWindow} (${tmuxStatus})`),
        );
        console.log(
          chalk.gray(`    channel: ${instance.channelId || '(none)'} (${channelStatus})`),
        );
        console.log(
          chalk.gray(`    runtime: ${describeRuntime(instance.runtime, instance.paneWorkingHint === true)}`),
        );
        if (instance.captureProbe) {
          const captureColor =
            instance.captureProbe.status === 'ok'
              ? chalk.green
              : instance.captureProbe.status === 'warn'
                ? chalk.yellow
                : chalk.red;
          console.log(
            captureColor(
              `    capture: ${instance.captureProbe.status} (${instance.captureProbe.detail})`,
            ),
          );
        }
      }
      console.log('');
    }

    const summaryColor =
      summary.fail > 0 ? chalk.red : summary.warn > 0 ? chalk.yellow : chalk.green;
    console.log(summaryColor(`Summary: ${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`));
    console.log('');
  }

  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}
