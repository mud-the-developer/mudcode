import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { config, getConfigPath, getConfigValue, saveConfig, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { listProjectInstances, normalizeProjectState } from '../../state/instances.js';
import { resolveOrchestratorRole } from '../../bridge/runtime/orchestrator-progress-policy.js';

const LONG_OUTPUT_THREAD_THRESHOLD_MIN = 1200;
const LONG_OUTPUT_THREAD_THRESHOLD_MAX = 20000;
const LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX = 100000;
const SAFE_DEFAULT_LONG_OUTPUT_THREAD_THRESHOLD = 20000;

export type ThresholdState =
  | { kind: 'missing' }
  | { kind: 'valid'; value: number }
  | { kind: 'legacy'; value: number }
  | { kind: 'invalid'; raw: unknown };

export interface DoctorCommandOptions {
  fix?: boolean;
  json?: boolean;
}

type DoctorIssueLevel = 'warn' | 'fail';

export type DoctorIssue = {
  level: DoctorIssueLevel;
  code: string;
  message: string;
};

export type DoctorFix = {
  code: string;
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  fixed: boolean;
  issues: DoctorIssue[];
  fixes: DoctorFix[];
  summary: {
    configPath: string;
    storedThreshold?: number;
    envThresholdRaw?: string;
    effectiveThreshold?: number;
    runtimeLifecycleRejectedCount?: number;
    runtimeLifecycleRejectedInstances?: number;
    runtimeProgressModeOff?: number;
    runtimeProgressModeThread?: number;
    runtimeProgressModeChannel?: number;
    runtimeProgressModeUnknown?: number;
    runtimeCodexProgressModeChannel?: number;
    runtimeOrchestratorSupervisorCount?: number;
    runtimeOrchestratorWorkerCount?: number;
    runtimeOrchestratorWorkerHiddenModeLeakCount?: number;
    runtimeOrchestratorWorkerThreadChannelMismatchCount?: number;
    runtimeOrchestratorSupervisorFinalFormatEnforceCount?: number;
    stateMappingTotalInstances?: number;
    stateMappingMappedInstances?: number;
    stateMappingRequiredMissingCount?: number;
    stateMappingOptionalWorkerMissingCount?: number;
    stateMappingDuplicateChannelCount?: number;
    eventHookCaptureFallbackStaleGraceMs?: number;
    promptRefinerMode?: string;
    promptRefinerPolicyPath?: string;
    promptRefinerPolicyPathExists?: boolean;
  };
};

type RuntimeStatusEntry = {
  projectName?: string;
  instanceId?: string;
  agentType?: string;
  lifecycleRejectedEventCount?: number;
  eventProgressMode?: string;
  orchestratorRole?: 'supervisor' | 'worker' | 'none';
  orchestratorWorkerVisibility?: 'hidden' | 'thread' | 'channel';
  orchestratorSupervisorFinalFormatEnforce?: boolean;
};

type RuntimeStatusPayload = {
  instances?: RuntimeStatusEntry[];
};

type RewriteResult = {
  content: string;
  changes: number;
};

type RuntimeContractSnapshot = {
  rejectedCount: number;
  rejectedInstances: number;
  codexChannelProgressInstances: number;
  orchestratorSupervisorCount: number;
  orchestratorWorkerCount: number;
  orchestratorWorkerHiddenModeLeakCount: number;
  orchestratorWorkerThreadChannelMismatchCount: number;
  orchestratorSupervisorFinalFormatEnforceCount: number;
  progressModeCounts: {
    off: number;
    thread: number;
    channel: number;
    unknown: number;
  };
};

type ChannelMappingAudit = {
  totalInstances: number;
  mappedInstances: number;
  requiredMissingCount: number;
  optionalWorkerMissingCount: number;
  duplicateChannels: Array<{ channelId: string; owners: string[] }>;
};

export function classifyLongOutputThreadThreshold(raw: unknown): ThresholdState {
  if (raw === undefined || raw === null || raw === '') return { kind: 'missing' };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return { kind: 'invalid', raw };
  if (parsed < LONG_OUTPUT_THREAD_THRESHOLD_MIN) return { kind: 'invalid', raw };
  if (parsed <= LONG_OUTPUT_THREAD_THRESHOLD_MAX) return { kind: 'valid', value: parsed };
  if (parsed <= LEGACY_LONG_OUTPUT_THREAD_THRESHOLD_MAX) return { kind: 'legacy', value: parsed };
  return { kind: 'invalid', raw };
}

function normalizeThresholdForStorage(raw: unknown): number | undefined {
  const state = classifyLongOutputThreadThreshold(raw);
  if (state.kind === 'valid') return state.value;
  if (state.kind === 'legacy') return LONG_OUTPUT_THREAD_THRESHOLD_MAX;
  return undefined;
}

function pickDesiredThreshold(storedRaw: unknown, envRaw: unknown): number {
  const stored = normalizeThresholdForStorage(storedRaw);
  if (stored !== undefined) return stored;

  const env = normalizeThresholdForStorage(envRaw);
  if (env !== undefined) return env;

  return SAFE_DEFAULT_LONG_OUTPUT_THREAD_THRESHOLD;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\'')))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function rewriteThresholdAssignments(content: string, replacement: number): RewriteResult {
  const lines = content.split('\n');
  let changes = 0;

  const rewritten = lines.map((line) => {
    const match = line.match(/^(\s*)(export\s+)?AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD\s*=\s*([^#]*?)(\s*(?:#.*)?)$/);
    if (!match) return line;

    const valueRaw = stripWrappingQuotes(match[3] || '');
    const state = classifyLongOutputThreadThreshold(valueRaw);
    if (state.kind === 'valid' && state.value === replacement) return line;
    if (state.kind === 'valid') return line;

    changes += 1;
    const indent = match[1] || '';
    const exportPrefix = match[2] || '';
    const commentSuffix = match[4] || '';
    return `${indent}${exportPrefix}AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD=${replacement}${commentSuffix}`;
  });

  return {
    content: rewritten.join('\n'),
    changes,
  };
}

function patchShellProfilesForThreshold(replacement: number): { changedFiles: string[]; totalChanges: number } {
  const profilePaths = [
    join(homedir(), '.zshrc'),
    join(homedir(), '.zprofile'),
    join(homedir(), '.bashrc'),
    join(homedir(), '.profile'),
  ];

  const changedFiles: string[] = [];
  let totalChanges = 0;

  for (const path of profilePaths) {
    if (!existsSync(path)) continue;
    const current = readFileSync(path, 'utf-8');
    const rewritten = rewriteThresholdAssignments(current, replacement);
    if (rewritten.changes <= 0) continue;
    writeFileSync(path, rewritten.content, 'utf-8');
    changedFiles.push(path);
    totalChanges += rewritten.changes;
  }

  return { changedFiles, totalChanges };
}

function buildIssues(storedRaw: unknown, envRaw: string | undefined): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const stored = classifyLongOutputThreadThreshold(storedRaw);
  const env = classifyLongOutputThreadThreshold(envRaw);

  if (stored.kind === 'invalid') {
    issues.push({
      level: 'fail',
      code: 'stored-threshold-invalid',
      message: `Stored longOutputThreadThreshold is invalid: ${String(storedRaw)}`,
    });
  }
  if (stored.kind === 'legacy') {
    issues.push({
      level: 'warn',
      code: 'stored-threshold-legacy',
      message: `Stored longOutputThreadThreshold is legacy and will be clamped to ${LONG_OUTPUT_THREAD_THRESHOLD_MAX}: ${stored.value}`,
    });
  }

  if (env.kind === 'invalid') {
    issues.push({
      level: 'fail',
      code: 'env-threshold-invalid',
      message: `AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD is invalid: ${String(envRaw)}`,
    });
  }
  if (env.kind === 'legacy') {
    issues.push({
      level: 'warn',
      code: 'env-threshold-legacy',
      message: `AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD is legacy and should be <= ${LONG_OUTPUT_THREAD_THRESHOLD_MAX}: ${env.value}`,
    });
  }

  if (stored.kind === 'valid' && env.kind === 'valid' && stored.value !== env.value) {
    issues.push({
      level: 'warn',
      code: 'threshold-conflict',
      message: `Threshold conflict: stored=${stored.value}, env=${env.value}. Stored value is used.`,
    });
  }

  return issues;
}

function parseIntEnv(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  if (parsed < min || parsed > max) return undefined;
  return Math.trunc(parsed);
}

function resolveStrictLifecycleMode(): 'off' | 'warn' | 'reject' {
  const raw = (process.env.AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE || '').trim().toLowerCase();
  if (raw === 'off' || raw === 'warn' || raw === 'reject') return raw;
  return 'warn';
}

function parseRuntimeProgressMode(raw: unknown): 'off' | 'thread' | 'channel' | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') {
    return normalized;
  }
  return undefined;
}

async function fetchRuntimeContractSnapshot(
  port: number,
): Promise<RuntimeContractSnapshot | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  timer.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/runtime-status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as RuntimeStatusPayload;
    const entries = Array.isArray(payload.instances) ? payload.instances : [];
    let rejectedCount = 0;
    let rejectedInstances = 0;
    let codexChannelProgressInstances = 0;
    let orchestratorSupervisorCount = 0;
    let orchestratorWorkerCount = 0;
    let orchestratorWorkerHiddenModeLeakCount = 0;
    let orchestratorWorkerThreadChannelMismatchCount = 0;
    let orchestratorSupervisorFinalFormatEnforceCount = 0;
    const progressModeCounts = {
      off: 0,
      thread: 0,
      channel: 0,
      unknown: 0,
    };
    for (const entry of entries) {
      const progressMode = parseRuntimeProgressMode(entry.eventProgressMode);
      if (progressMode === 'off') progressModeCounts.off += 1;
      else if (progressMode === 'thread') progressModeCounts.thread += 1;
      else if (progressMode === 'channel') progressModeCounts.channel += 1;
      else progressModeCounts.unknown += 1;
      const agentType = typeof entry.agentType === 'string' ? entry.agentType.trim().toLowerCase() : '';
      if (agentType === 'codex' && progressMode === 'channel') {
        codexChannelProgressInstances += 1;
      }
      const role = entry.orchestratorRole;
      if (role === 'supervisor') {
        orchestratorSupervisorCount += 1;
        if (entry.orchestratorSupervisorFinalFormatEnforce === true) {
          orchestratorSupervisorFinalFormatEnforceCount += 1;
        }
      } else if (role === 'worker') {
        orchestratorWorkerCount += 1;
        const visibility = entry.orchestratorWorkerVisibility;
        if (visibility === 'hidden' && progressMode && progressMode !== 'off') {
          orchestratorWorkerHiddenModeLeakCount += 1;
        }
        if (visibility === 'thread' && progressMode === 'channel') {
          orchestratorWorkerThreadChannelMismatchCount += 1;
        }
      }

      const count =
        typeof entry.lifecycleRejectedEventCount === 'number' &&
        Number.isFinite(entry.lifecycleRejectedEventCount)
          ? Math.max(0, Math.trunc(entry.lifecycleRejectedEventCount))
          : 0;
      if (count <= 0) continue;
      rejectedCount += count;
      rejectedInstances += 1;
    }
    return {
      rejectedCount,
      rejectedInstances,
      codexChannelProgressInstances,
      orchestratorSupervisorCount,
      orchestratorWorkerCount,
      orchestratorWorkerHiddenModeLeakCount,
      orchestratorWorkerThreadChannelMismatchCount,
      orchestratorSupervisorFinalFormatEnforceCount,
      progressModeCounts,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function printHumanResult(result: DoctorResult): void {
  const warnCount = result.issues.filter((issue) => issue.level === 'warn').length;
  const failCount = result.issues.filter((issue) => issue.level === 'fail').length;

  console.log(chalk.cyan('\n🩺 Mudcode Doctor\n'));
  console.log(chalk.gray(`   Config: ${result.summary.configPath}`));
  console.log(chalk.gray(`   Stored threshold: ${result.summary.storedThreshold ?? '(unset)'}`));
  console.log(chalk.gray(`   Env threshold: ${result.summary.envThresholdRaw ?? '(unset)'}`));
  console.log(chalk.gray(`   Effective threshold: ${result.summary.effectiveThreshold ?? '(unset)'}`));
  if (typeof result.summary.runtimeLifecycleRejectedCount === 'number') {
    console.log(
      chalk.gray(
        `   Runtime lifecycle rejects: ${result.summary.runtimeLifecycleRejectedCount}` +
        ` (${result.summary.runtimeLifecycleRejectedInstances ?? 0} instance(s))`,
      ),
    );
  }
  if (
    typeof result.summary.runtimeProgressModeOff === 'number' ||
    typeof result.summary.runtimeProgressModeThread === 'number' ||
    typeof result.summary.runtimeProgressModeChannel === 'number'
  ) {
    console.log(
      chalk.gray(
        `   Runtime progress modes: ` +
        `off=${result.summary.runtimeProgressModeOff ?? 0}, ` +
        `thread=${result.summary.runtimeProgressModeThread ?? 0}, ` +
        `channel=${result.summary.runtimeProgressModeChannel ?? 0}, ` +
        `unknown=${result.summary.runtimeProgressModeUnknown ?? 0}`,
      ),
    );
  }
  if (typeof result.summary.runtimeCodexProgressModeChannel === 'number') {
    console.log(
      chalk.gray(
        `   Runtime codex channel-mode instances: ${result.summary.runtimeCodexProgressModeChannel}`,
      ),
    );
  }
  if (typeof result.summary.eventHookCaptureFallbackStaleGraceMs === 'number') {
    console.log(
      chalk.gray(
        `   Event-hook fallback staleGraceMs: ${result.summary.eventHookCaptureFallbackStaleGraceMs}`,
      ),
    );
  }
  if (
    typeof result.summary.runtimeOrchestratorSupervisorCount === 'number' ||
    typeof result.summary.runtimeOrchestratorWorkerCount === 'number'
  ) {
    console.log(
      chalk.gray(
        `   Runtime orchestrator roles: ` +
        `supervisor=${result.summary.runtimeOrchestratorSupervisorCount ?? 0}, ` +
        `worker=${result.summary.runtimeOrchestratorWorkerCount ?? 0}`,
      ),
    );
  }
  if (typeof result.summary.runtimeOrchestratorSupervisorFinalFormatEnforceCount === 'number') {
    console.log(
      chalk.gray(
        `   Runtime supervisor final-format enforce: ${result.summary.runtimeOrchestratorSupervisorFinalFormatEnforceCount}`,
      ),
    );
  }
  if (result.summary.promptRefinerMode || result.summary.promptRefinerPolicyPath) {
    console.log(
      chalk.gray(
        `   Prompt refiner runtime: mode=${result.summary.promptRefinerMode || 'off'}, ` +
        `policyPath=${result.summary.promptRefinerPolicyPath || '(unset)'}, ` +
        `policyExists=${result.summary.promptRefinerPolicyPathExists === undefined ? '(unknown)' : result.summary.promptRefinerPolicyPathExists ? 'yes' : 'no'}`,
      ),
    );
  }
  if (
    typeof result.summary.runtimeOrchestratorWorkerHiddenModeLeakCount === 'number' ||
    typeof result.summary.runtimeOrchestratorWorkerThreadChannelMismatchCount === 'number'
  ) {
    console.log(
      chalk.gray(
        `   Runtime orchestrator policy drift: ` +
        `hidden-leak=${result.summary.runtimeOrchestratorWorkerHiddenModeLeakCount ?? 0}, ` +
        `thread-channel-mismatch=${result.summary.runtimeOrchestratorWorkerThreadChannelMismatchCount ?? 0}`,
      ),
    );
  }
  if (
    typeof result.summary.stateMappingTotalInstances === 'number' ||
    typeof result.summary.stateMappingDuplicateChannelCount === 'number'
  ) {
    console.log(
      chalk.gray(
        `   State mapping audit: ` +
        `total=${result.summary.stateMappingTotalInstances ?? 0}, ` +
        `mapped=${result.summary.stateMappingMappedInstances ?? 0}, ` +
        `required-missing=${result.summary.stateMappingRequiredMissingCount ?? 0}, ` +
        `worker-optional-missing=${result.summary.stateMappingOptionalWorkerMissingCount ?? 0}, ` +
        `duplicate-channel-ids=${result.summary.stateMappingDuplicateChannelCount ?? 0}`,
      ),
    );
  }

  if (result.issues.length === 0) {
    console.log(chalk.green('\n✅ No config/env conflicts found.'));
  } else {
    console.log(chalk.white('\nIssues:'));
    for (const issue of result.issues) {
      const color = issue.level === 'fail' ? chalk.red : chalk.yellow;
      console.log(color(`- [${issue.level.toUpperCase()}] ${issue.code}: ${issue.message}`));
    }
  }

  if (result.fixes.length > 0) {
    console.log(chalk.white('\nApplied fixes:'));
    for (const fix of result.fixes) {
      console.log(chalk.green(`- ${fix.code}: ${fix.message}`));
    }
  }

  if (!result.ok) {
    console.log(chalk.red(`\n❌ Doctor finished with ${failCount} failure(s), ${warnCount} warning(s).`));
  } else if (warnCount > 0) {
    console.log(chalk.yellow(`\n⚠️ Doctor finished with ${warnCount} warning(s).`));
  } else {
    console.log(chalk.green('\n✅ Doctor finished clean.'));
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function auditChannelMappingsFromState(): ChannelMappingAudit {
  const channelOwners = new Map<string, string[]>();
  let totalInstances = 0;
  let mappedInstances = 0;
  let requiredMissingCount = 0;
  let optionalWorkerMissingCount = 0;

  for (const rawProject of stateManager.listProjects()) {
    const project = normalizeProjectState(rawProject);
    for (const instance of listProjectInstances(project)) {
      totalInstances += 1;
      const role = resolveOrchestratorRole({
        project,
        instanceId: instance.instanceId,
        agentType: instance.agentType,
      });
      const channelId = instance.channelId?.trim();
      if (channelId) {
        mappedInstances += 1;
        const owner = `${project.projectName}/${instance.instanceId}`;
        const owners = channelOwners.get(channelId) || [];
        owners.push(owner);
        channelOwners.set(channelId, owners);
      } else if (role === 'worker') {
        optionalWorkerMissingCount += 1;
      } else {
        requiredMissingCount += 1;
      }
    }
  }

  const duplicateChannels = [...channelOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([channelId, owners]) => ({ channelId, owners }));

  return {
    totalInstances,
    mappedInstances,
    requiredMissingCount,
    optionalWorkerMissingCount,
    duplicateChannels,
  };
}

export async function doctorCommand(options: DoctorCommandOptions = {}): Promise<void> {
  const result = await runDoctor(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanResult(result);
    if (!options.fix && result.issues.length > 0) {
      console.log(chalk.gray('\nTip: run `mudcode doctor --fix` to apply safe auto-fixes.'));
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function runDoctor(options: { fix?: boolean } = {}): Promise<DoctorResult> {
  const storedRaw = getConfigValue('longOutputThreadThreshold');
  const envRaw = process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD;
  const issues = buildIssues(storedRaw, envRaw);
  const fixes: DoctorFix[] = [];
  const strictLifecycleMode = resolveStrictLifecycleMode();
  const eventHookCaptureFallbackStaleGraceMs =
    parseIntEnv(process.env.AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS, 0, 5 * 60 * 1000) ?? 10_000;
  if (strictLifecycleMode === 'off') {
    issues.push({
      level: 'warn',
      code: 'event-contract-strict-off',
      message:
        'Codex runtime relies on start/final event contracts, but AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE=off. Consider warn/reject to catch missing lifecycle contracts.',
    });
  }
  if (eventHookCaptureFallbackStaleGraceMs > 30_000) {
    issues.push({
      level: 'warn',
      code: 'event-only-capture-fallback-grace-high',
      message:
        `AGENT_DISCORD_EVENT_HOOK_CAPTURE_FALLBACK_STALE_GRACE_MS=${eventHookCaptureFallbackStaleGraceMs}ms is high. ` +
        'Fallback recovery may be delayed when hook lifecycle is stale.',
    });
  }

  const promptRefinerMode = config.promptRefiner?.mode || 'off';
  const promptRefinerPolicyPath = config.promptRefiner?.policyPath?.trim() || '';
  const promptRefinerPolicyPathExists = promptRefinerPolicyPath ? existsSync(promptRefinerPolicyPath) : false;
  if (promptRefinerMode === 'enforce' && !promptRefinerPolicyPath) {
    issues.push({
      level: 'warn',
      code: 'prompt-refiner-enforce-no-policy-path',
      message:
        'Prompt refiner mode=enforce but promptRefinerPolicyPath is not set. Configure policy path or switch to shadow.',
    });
  }
  if (promptRefinerPolicyPath && !promptRefinerPolicyPathExists) {
    issues.push({
      level: 'warn',
      code: 'prompt-refiner-policy-path-missing',
      message: `Prompt refiner policy path does not exist on disk: ${promptRefinerPolicyPath}`,
    });
  }

  if (options.fix) {
    const desired = pickDesiredThreshold(storedRaw, envRaw);
    const normalizedStored = normalizeThresholdForStorage(storedRaw);
    if (normalizedStored !== desired) {
      saveConfig({ longOutputThreadThreshold: desired });
      fixes.push({
        code: 'save-config-threshold',
        message: `Saved longOutputThreadThreshold=${desired} in config.json`,
      });
    }

    const envState = classifyLongOutputThreadThreshold(envRaw);
    const shouldPatchShell = envState.kind !== 'missing' && (envState.kind !== 'valid' || (envState.kind === 'valid' && envState.value !== desired));
    if (shouldPatchShell) {
      const patched = patchShellProfilesForThreshold(desired);
      if (patched.totalChanges > 0) {
        fixes.push({
          code: 'patch-shell-profiles',
          message: `Updated ${patched.totalChanges} assignment(s) in ${patched.changedFiles.length} profile file(s)`,
        });
      }
      if (process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD !== undefined) {
        delete process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD;
        fixes.push({
          code: 'unset-process-env',
          message: 'Cleared AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD in current process',
        });
      }
    }

    if (promptRefinerMode === 'enforce' && !promptRefinerPolicyPath) {
      saveConfig({ promptRefinerMode: 'shadow' });
      fixes.push({
        code: 'prompt-refiner-safe-downgrade',
        message: 'Downgraded promptRefinerMode to shadow because enforce mode had no policy path.',
      });
    }
  }

  let validationError: string | undefined;
  try {
    validateConfig();
  } catch (error) {
    validationError = safeErrorMessage(error);
  }

  const resultIssues = [...issues];
  const runtimeContract = await fetchRuntimeContractSnapshot(config.hookServerPort || 18470);
  const mappingAudit = auditChannelMappingsFromState();
  if (mappingAudit.requiredMissingCount > 0) {
    resultIssues.push({
      level: 'fail',
      code: 'mapping-required-channel-missing',
      message:
        `Detected ${mappingAudit.requiredMissingCount} non-worker instance(s)` +
        ' without channel mapping in state.',
    });
  }
  if (mappingAudit.duplicateChannels.length > 0) {
    const example = mappingAudit.duplicateChannels[0];
    const exampleText = example
      ? ` (e.g. \`${example.channelId}\` -> ${example.owners.join(', ')})`
      : '';
    resultIssues.push({
      level: 'fail',
      code: 'mapping-duplicate-channel-id',
      message:
        `Detected ${mappingAudit.duplicateChannels.length} duplicate channel mapping(s)` +
        ` across instances${exampleText}.`,
    });
  }
  if (runtimeContract && runtimeContract.rejectedCount > 0) {
    resultIssues.push({
      level: strictLifecycleMode === 'reject' ? 'fail' : 'warn',
      code: 'event-contract-rejected',
      message:
        `Detected ${runtimeContract.rejectedCount} lifecycle-rejected event(s)` +
        ` across ${runtimeContract.rejectedInstances} instance(s) from /runtime-status.`,
    });
  }
  if (runtimeContract && runtimeContract.codexChannelProgressInstances > 0) {
    resultIssues.push({
      level: 'warn',
      code: 'event-contract-progress-channel',
      message:
        `${runtimeContract.codexChannelProgressInstances}` +
        ' codex instance(s) currently report runtime progressMode=channel; use thread/off to avoid intermediary channel output.',
    });
  }
  if (runtimeContract && runtimeContract.orchestratorWorkerHiddenModeLeakCount > 0) {
    resultIssues.push({
      level: 'warn',
      code: 'orchestrator-worker-hidden-progress-leak',
      message:
        `Detected ${runtimeContract.orchestratorWorkerHiddenModeLeakCount} worker instance(s)` +
        ' with hidden visibility but runtime progressMode is not off.',
    });
  }
  if (runtimeContract && runtimeContract.orchestratorWorkerThreadChannelMismatchCount > 0) {
    resultIssues.push({
      level: 'warn',
      code: 'orchestrator-worker-thread-channel-mismatch',
      message:
        `Detected ${runtimeContract.orchestratorWorkerThreadChannelMismatchCount} worker instance(s)` +
        ' with thread visibility but runtime progressMode=channel.',
    });
  }
  if (validationError) {
    resultIssues.push({
      level: 'fail',
      code: 'validate-config-failed',
      message: validationError,
    });
  }

  const result: DoctorResult = {
    ok: resultIssues.every((issue) => issue.level !== 'fail'),
    fixed: fixes.length > 0,
    issues: resultIssues,
    fixes,
    summary: {
      configPath: getConfigPath(),
      storedThreshold: normalizeThresholdForStorage(getConfigValue('longOutputThreadThreshold')),
      envThresholdRaw: process.env.AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD,
      effectiveThreshold: config.capture?.longOutputThreadThreshold,
      runtimeLifecycleRejectedCount: runtimeContract?.rejectedCount,
      runtimeLifecycleRejectedInstances: runtimeContract?.rejectedInstances,
      runtimeProgressModeOff: runtimeContract?.progressModeCounts.off,
      runtimeProgressModeThread: runtimeContract?.progressModeCounts.thread,
      runtimeProgressModeChannel: runtimeContract?.progressModeCounts.channel,
      runtimeProgressModeUnknown: runtimeContract?.progressModeCounts.unknown,
      runtimeCodexProgressModeChannel: runtimeContract?.codexChannelProgressInstances,
      runtimeOrchestratorSupervisorCount: runtimeContract?.orchestratorSupervisorCount,
      runtimeOrchestratorWorkerCount: runtimeContract?.orchestratorWorkerCount,
      runtimeOrchestratorWorkerHiddenModeLeakCount: runtimeContract?.orchestratorWorkerHiddenModeLeakCount,
      runtimeOrchestratorWorkerThreadChannelMismatchCount:
        runtimeContract?.orchestratorWorkerThreadChannelMismatchCount,
      runtimeOrchestratorSupervisorFinalFormatEnforceCount:
        runtimeContract?.orchestratorSupervisorFinalFormatEnforceCount,
      stateMappingTotalInstances: mappingAudit.totalInstances,
      stateMappingMappedInstances: mappingAudit.mappedInstances,
      stateMappingRequiredMissingCount: mappingAudit.requiredMissingCount,
      stateMappingOptionalWorkerMissingCount: mappingAudit.optionalWorkerMissingCount,
      stateMappingDuplicateChannelCount: mappingAudit.duplicateChannels.length,
      eventHookCaptureFallbackStaleGraceMs,
      promptRefinerMode,
      promptRefinerPolicyPath: promptRefinerPolicyPath || undefined,
      promptRefinerPolicyPathExists: promptRefinerPolicyPath ? promptRefinerPolicyPathExists : undefined,
    },
  };
  return result;
}
