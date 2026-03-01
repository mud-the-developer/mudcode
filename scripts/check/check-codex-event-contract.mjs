#!/usr/bin/env node

function parseProgressMode(raw) {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'thread' || normalized === 'channel') return normalized;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'thread';
  if (['0', 'false', 'no'].includes(normalized)) return 'off';
  return undefined;
}

function parseExpectedProgressMode(raw) {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'skip' || normalized === 'none') return 'skip';
  if (normalized === 'auto') return 'auto';
  return parseProgressMode(normalized);
}

function parseBooleanEnv(raw) {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function resolveExpectedProgressMode(options) {
  if (options.expectedProgressModeRaw === 'skip') return undefined;
  if (options.expectedProgressModeRaw && options.expectedProgressModeRaw !== 'auto') {
    return options.expectedProgressModeRaw;
  }
  if (options.progressModeOverride) return options.progressModeOverride;
  const envMode = parseProgressMode(process.env.AGENT_DISCORD_EVENT_PROGRESS_FORWARD);
  return envMode || 'off';
}

function parseArgs(argv) {
  const options = {
    port: Number(process.env.HOOK_SERVER_PORT || process.env.AGENT_DISCORD_PORT || 18470),
    agentType: 'codex',
    projectName: undefined,
    instanceId: undefined,
    timeoutMs: 3000,
    checkSeqGuard: true,
    progressModeOverride: undefined,
    expectedProgressModeRaw: 'auto',
    checkProgressMode: true,
    maxProgressModeAgeMs: Number(process.env.AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS || 90_000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--port' && next) {
      options.port = Number(next);
      i += 1;
      continue;
    }
    if (token === '--agent-type' && next) {
      options.agentType = String(next);
      i += 1;
      continue;
    }
    if (token === '--project' && next) {
      options.projectName = String(next);
      i += 1;
      continue;
    }
    if (token === '--instance' && next) {
      options.instanceId = String(next);
      i += 1;
      continue;
    }
    if (token === '--timeout-ms' && next) {
      options.timeoutMs = Number(next);
      i += 1;
      continue;
    }
    if (token === '--progress-mode' && next) {
      const parsed = parseProgressMode(next);
      if (!parsed) {
        throw new Error(`invalid --progress-mode: ${next} (expected off|thread|channel)`);
      }
      options.progressModeOverride = parsed;
      i += 1;
      continue;
    }
    if (token === '--expect-progress-mode' && next) {
      const parsed = parseExpectedProgressMode(next);
      if (!parsed) {
        throw new Error(`invalid --expect-progress-mode: ${next} (expected auto|skip|off|thread|channel)`);
      }
      options.expectedProgressModeRaw = parsed;
      i += 1;
      continue;
    }
    if (token === '--max-progress-mode-age-ms' && next) {
      options.maxProgressModeAgeMs = Number(next);
      i += 1;
      continue;
    }
    if (token === '--no-progress-mode-check') {
      options.checkProgressMode = false;
      continue;
    }
    if (token === '--no-seq-guard-check') {
      options.checkSeqGuard = false;
      continue;
    }
    if (token === '-h' || token === '--help') {
      printHelp();
      process.exit(0);
    }
    console.error(`[event-contract-check] unknown argument: ${token}`);
    printHelp();
    process.exit(2);
  }

  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`invalid --port: ${options.port}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 500 || options.timeoutMs > 60_000) {
    throw new Error(`invalid --timeout-ms: ${options.timeoutMs}`);
  }
  if (
    !Number.isFinite(options.maxProgressModeAgeMs) ||
    options.maxProgressModeAgeMs < 1_000 ||
    options.maxProgressModeAgeMs > 3_600_000
  ) {
    throw new Error(`invalid --max-progress-mode-age-ms: ${options.maxProgressModeAgeMs}`);
  }
  options.expectedProgressMode = resolveExpectedProgressMode(options);
  return options;
}

function printHelp() {
  console.log(
    [
      'Usage: node scripts/check/check-codex-event-contract.mjs [options]',
      '',
      'Options:',
      '  --port <n>              Hook server port (default: HOOK_SERVER_PORT/AGENT_DISCORD_PORT/18470)',
      '  --project <name>        Target project name (optional)',
      '  --instance <id>         Target instance id (optional)',
      '  --agent-type <type>     Agent type filter (default: codex)',
      '  --timeout-ms <n>        HTTP timeout in ms (default: 3000)',
      '  --progress-mode <mode>  Include progressMode in session.progress (off|thread|channel)',
      '  --expect-progress-mode <mode>',
      '                          Expected runtime eventProgressMode (auto|skip|off|thread|channel)',
      '  --max-progress-mode-age-ms <n>',
      '                          Max allowed eventProgressModeAgeMs (default: env stale warn or 90000)',
      '  --no-progress-mode-check',
      '                          Skip runtime progressMode/age validation',
      '  --no-seq-guard-check    Skip out-of-order sequence guard validation',
      '  -h, --help              Show this help',
    ].join('\n'),
  );
}

async function requestJson(baseUrl, path, method, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let parsed = undefined;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function selectTargetInstance(runtime, opts) {
  const all = Array.isArray(runtime?.instances) ? runtime.instances : [];
  const filtered = all.filter((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    if (entry.agentType !== opts.agentType) return false;
    if (opts.projectName && entry.projectName !== opts.projectName) return false;
    if (opts.instanceId && entry.instanceId !== opts.instanceId) return false;
    return true;
  });
  if (filtered.length > 0) return filtered[0];
  return undefined;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${opts.port}`;

  const runtimeBefore = await requestJson(baseUrl, '/runtime-status', 'GET', undefined, opts.timeoutMs);
  if (!runtimeBefore.ok || typeof runtimeBefore.body !== 'object' || runtimeBefore.body === null) {
    throw new Error(`failed to read /runtime-status (status=${runtimeBefore.status})`);
  }

  const target = selectTargetInstance(runtimeBefore.body, opts);
  if (!target) {
    const instances = Array.isArray(runtimeBefore.body.instances) ? runtimeBefore.body.instances : [];
    const codexList = instances
      .filter((entry) => entry && typeof entry === 'object' && entry.agentType === opts.agentType)
      .map((entry) => `${entry.projectName}/${entry.instanceId}`);
    const suffix = codexList.length > 0 ? ` available: ${codexList.join(', ')}` : ' (no matching instances)';
    throw new Error(`target instance not found for agentType=${opts.agentType}.${suffix}`);
  }

  const projectName = String(target.projectName);
  const instanceId = String(target.instanceId);
  const turnId = `evt-check-${Date.now().toString(36)}`;

  const events = [
    { type: 'session.start', seq: 1, eventId: `${turnId}:start` },
    {
      type: 'session.progress',
      seq: 2,
      eventId: `${turnId}:progress`,
      ...(opts.progressModeOverride ? { progressMode: opts.progressModeOverride } : {}),
    },
    { type: 'session.final', seq: 3, eventId: `${turnId}:final` },
  ];

  for (const event of events) {
    const response = await requestJson(
      baseUrl,
      '/agent-event',
      'POST',
      {
        projectName,
        agentType: opts.agentType,
        instanceId,
        turnId,
        source: 'codex-poc',
        ...event,
      },
      opts.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(`failed to post ${event.type} (status=${response.status})`);
    }
  }

  const runtimeAfter = await requestJson(baseUrl, '/runtime-status', 'GET', undefined, opts.timeoutMs);
  if (!runtimeAfter.ok || typeof runtimeAfter.body !== 'object' || runtimeAfter.body === null) {
    throw new Error(`failed to read /runtime-status after events (status=${runtimeAfter.status})`);
  }
  const afterTarget = selectTargetInstance(runtimeAfter.body, {
    ...opts,
    projectName,
    instanceId,
  });
  if (!afterTarget) {
    throw new Error('target instance disappeared from /runtime-status');
  }

  if (afterTarget.eventLifecycleStage !== 'final') {
    throw new Error(`expected eventLifecycleStage=final, got ${String(afterTarget.eventLifecycleStage)}`);
  }
  if (afterTarget.eventLifecycleTurnId !== turnId) {
    throw new Error(`expected eventLifecycleTurnId=${turnId}, got ${String(afterTarget.eventLifecycleTurnId)}`);
  }
  if (Number(afterTarget.eventLifecycleSeq) !== 3) {
    throw new Error(`expected eventLifecycleSeq=3, got ${String(afterTarget.eventLifecycleSeq)}`);
  }
  if (opts.checkProgressMode && opts.expectedProgressMode) {
    const observedProgressMode = parseProgressMode(afterTarget.eventProgressMode);
    if (observedProgressMode !== opts.expectedProgressMode) {
      const maybeEventOnlyHint =
        opts.agentType === 'codex' &&
        opts.expectedProgressMode === 'thread' &&
        observedProgressMode === 'channel' &&
        parseBooleanEnv(process.env.AGENT_DISCORD_CODEX_EVENT_ONLY) === true
          ? ' (hint: restart daemon with AGENT_DISCORD_CODEX_EVENT_ONLY=1; current shell env alone does not change daemon runtime)'
          : '';
      throw new Error(
        `expected eventProgressMode=${opts.expectedProgressMode}, got ${String(afterTarget.eventProgressMode)}${maybeEventOnlyHint}`,
      );
    }
    const progressModeAgeMs =
      typeof afterTarget.eventProgressModeAgeMs === 'number' && Number.isFinite(afterTarget.eventProgressModeAgeMs)
        ? Math.max(0, Math.trunc(afterTarget.eventProgressModeAgeMs))
        : undefined;
    if (typeof progressModeAgeMs !== 'number') {
      throw new Error('missing eventProgressModeAgeMs in runtime-status');
    }
    if (progressModeAgeMs > opts.maxProgressModeAgeMs) {
      throw new Error(
        `eventProgressModeAgeMs too old: ${progressModeAgeMs} > ${opts.maxProgressModeAgeMs}`,
      );
    }
  }

  if (opts.checkSeqGuard) {
    const staleResponse = await requestJson(
      baseUrl,
      '/agent-event',
      'POST',
      {
        projectName,
        agentType: opts.agentType,
        instanceId,
        turnId,
        source: 'codex-poc',
        type: 'session.progress',
        seq: 2,
        eventId: `${turnId}:stale-progress`,
      },
      opts.timeoutMs,
    );
    if (!staleResponse.ok) {
      throw new Error(`failed to post stale seq event (status=${staleResponse.status})`);
    }

    const runtimeSeqCheck = await requestJson(baseUrl, '/runtime-status', 'GET', undefined, opts.timeoutMs);
    const seqTarget = selectTargetInstance(runtimeSeqCheck.body, {
      ...opts,
      projectName,
      instanceId,
    });
    if (!seqTarget) throw new Error('target instance missing in seq guard check');
    if (Number(seqTarget.eventLifecycleSeq) !== 3) {
      throw new Error(
        `sequence guard failed: expected eventLifecycleSeq=3 after stale event, got ${String(seqTarget.eventLifecycleSeq)}`,
      );
    }
  }

  console.log(
    `[event-contract-check] OK project=${projectName} instance=${instanceId} turnId=${turnId} ` +
      `stage=final seq=3 progressMode=${opts.expectedProgressMode || 'skip'}`,
  );
}

main().catch((error) => {
  console.error(`[event-contract-check] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
