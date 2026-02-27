import { once } from 'events';
import chalk from 'chalk';
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';
import { config, validateConfig } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { getProjectInstance, listProjectInstances, normalizeProjectState } from '../../state/instances.js';

export interface DiagnoseCommandOptions {
  project?: string;
  instance?: string;
  channel?: string;
  lookback?: number;
  timeoutMs?: number;
  skipProbe?: boolean;
  ioBoundary?: boolean;
  includeOversize?: boolean;
}

export interface DiagnosticPatternHit {
  code: string;
  label: string;
  count: number;
}

interface DiagnosticMessage {
  id: string;
  content: string;
  author?: { id?: string };
}

interface DiagnosticTextChannel {
  type: number;
  messages: {
    fetch: (options: { limit: number }) => Promise<Map<string, DiagnosticMessage>>;
  };
  send: (payload: { content: string }) => Promise<{ id: string }>;
}

interface IOBoundaryProbeResult {
  targetLength: number;
  sendOk: boolean;
  readOk: boolean;
  exactLength: boolean;
  exactContent: boolean;
  observedLength: number | null;
  latencyMs: number | null;
  expectedFailure: boolean;
  error?: string;
}

type IOBoundaryStatus = 'not-run' | 'ok' | 'warn' | 'fail';
type DiagnoseResultStatus = 'ok' | 'warn' | 'fail';

const DIAGNOSTIC_PATTERNS: Array<{ code: string; label: string; pattern: RegExp }> = [
  { code: 'stale-screen', label: 'stale screen warnings', pattern: /no screen updates for|still no screen updates for/i },
  { code: 'mapping-missing', label: 'instance/channel mapping missing', pattern: /agent instance mapping not found/i },
  { code: 'project-missing', label: 'project missing in state', pattern: /project ".+" not found in state/i },
  { code: 'delivery-failed', label: 'tmux delivery failures', pattern: /i couldn't deliver your message|couldn't deliver your message/i },
  { code: 'invalid-message', label: 'invalid message rejections', pattern: /invalid message: empty, too long/i },
  { code: 'tracker-desync', label: 'tracker/pane desync warnings', pattern: /tracker queue is empty, but pane still shows working/i },
];

const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_IO_BOUNDARY_LENGTHS = [1990, 1999, 2000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(raw!)));
}

function normalizeStatusToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9._-]/g, '');
}

function resolveTargetChannel(options: DiagnoseCommandOptions): { channelId: string; source: string } | null {
  const explicit = options.channel?.trim();
  if (explicit) {
    return { channelId: explicit, source: 'explicit --channel' };
  }

  stateManager.reload();

  const byProject = options.project?.trim();
  if (byProject) {
    const project = stateManager.getProject(byProject);
    if (!project) return null;

    const normalized = normalizeProjectState(project);
    const byInstance = options.instance?.trim();
    if (byInstance) {
      const instance = getProjectInstance(normalized, byInstance);
      if (instance?.channelId) {
        return { channelId: instance.channelId, source: `${byProject}/${byInstance}` };
      }
      return null;
    }

    const firstWithChannel = listProjectInstances(normalized).find((instance) => !!instance.channelId);
    if (firstWithChannel?.channelId) {
      return { channelId: firstWithChannel.channelId, source: `${byProject}/${firstWithChannel.instanceId}` };
    }
    return null;
  }

  const defaultChannel = config.discord.channelId?.trim();
  if (defaultChannel) {
    return { channelId: defaultChannel, source: 'config.discord.channelId' };
  }

  for (const project of stateManager.listProjects()) {
    const normalized = normalizeProjectState(project);
    const firstWithChannel = listProjectInstances(normalized).find((instance) => !!instance.channelId);
    if (firstWithChannel?.channelId) {
      return { channelId: firstWithChannel.channelId, source: `${project.projectName}/${firstWithChannel.instanceId}` };
    }
  }

  return null;
}

export function analyzeDiagnosticMessages(contents: string[]): DiagnosticPatternHit[] {
  const joined = contents.join('\n');
  return DIAGNOSTIC_PATTERNS
    .map((entry) => {
      const matches = joined.match(new RegExp(entry.pattern.source, `${entry.pattern.flags}g`));
      return {
        code: entry.code,
        label: entry.label,
        count: matches?.length || 0,
      };
    })
    .filter((hit) => hit.count > 0);
}

export function getBoundaryProbeLengths(includeOversize: boolean): number[] {
  const lengths: number[] = [...DEFAULT_IO_BOUNDARY_LENGTHS];
  if (includeOversize) {
    lengths.push(DISCORD_MESSAGE_LIMIT + 1);
  }
  return lengths;
}

export function buildBoundaryProbeMessage(targetLength: number, nonce: string, label: string): string {
  if (!Number.isFinite(targetLength)) {
    throw new Error(`invalid target length: ${targetLength}`);
  }
  const normalizedTarget = Math.trunc(targetLength);
  const prefix = `[mudcode-diagnose:${label}:${nonce}] `;
  const fillerLength = normalizedTarget - prefix.length;
  if (fillerLength < 0) {
    throw new Error(`target length ${normalizedTarget} is too small for probe prefix (${prefix.length})`);
  }
  return `${prefix}${'x'.repeat(fillerLength)}`;
}

export function buildDiagnoseStatusCodeLine(status: {
  result: DiagnoseResultStatus;
  probeStatus: string;
  ioBoundaryStatus: IOBoundaryStatus;
  patternCount: number;
  criticalPatterns: boolean;
  newPatternCount: number;
}): string {
  const patternCount = Math.max(0, Math.trunc(status.patternCount));
  const newPatternCount = Math.max(0, Math.trunc(status.newPatternCount));
  return [
    'STATUS_CODE',
    `MUDCODE_DIAGNOSE=${status.result.toUpperCase()}`,
    `probe=${normalizeStatusToken(status.probeStatus)}`,
    `io_boundary=${normalizeStatusToken(status.ioBoundaryStatus)}`,
    `patterns=${patternCount}`,
    `critical=${status.criticalPatterns ? '1' : '0'}`,
    `new_patterns=${newPatternCount}`,
  ].join(' ');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

async function waitForMessageById(
  textChannel: DiagnosticTextChannel,
  messageId: string,
  timeoutMs: number,
): Promise<DiagnosticMessage | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const page = await textChannel.messages.fetch({ limit: 40 });
    const found = page.get(messageId);
    if (found) return found;
    await sleep(400);
  }
  return null;
}

async function runIOBoundaryProbe(
  textChannel: DiagnosticTextChannel,
  timeoutMs: number,
  includeOversize: boolean,
): Promise<{ status: IOBoundaryStatus; results: IOBoundaryProbeResult[] }> {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const lengths = getBoundaryProbeLengths(includeOversize);
  const results: IOBoundaryProbeResult[] = [];

  console.log(chalk.cyan('\nDiscord I/O boundary probe:'));
  console.log(chalk.gray(`Lengths: ${lengths.join(', ')} chars`));

  for (const length of lengths) {
    const expectedFailure = length > DISCORD_MESSAGE_LIMIT;
    let payload: string;

    try {
      payload = buildBoundaryProbeMessage(length, nonce, `len${length}`);
    } catch (error) {
      results.push({
        targetLength: length,
        sendOk: false,
        readOk: false,
        exactLength: false,
        exactContent: false,
        observedLength: null,
        latencyMs: null,
        expectedFailure,
        error: errorMessage(error),
      });
      continue;
    }

    const sentAt = Date.now();

    try {
      const sent = await textChannel.send({ content: payload });

      const seen = await waitForMessageById(textChannel, sent.id, timeoutMs);
      if (!seen) {
        results.push({
          targetLength: length,
          sendOk: true,
          readOk: false,
          exactLength: false,
          exactContent: false,
          observedLength: null,
          latencyMs: Date.now() - sentAt,
          expectedFailure,
          error: `not observed within ${timeoutMs}ms`,
        });
        continue;
      }

      const observedLength = seen.content.length;
      const exactLength = observedLength === payload.length;
      const exactContent = seen.content === payload;
      results.push({
        targetLength: length,
        sendOk: true,
        readOk: true,
        exactLength,
        exactContent,
        observedLength,
        latencyMs: Date.now() - sentAt,
        expectedFailure,
      });
    } catch (error) {
      results.push({
        targetLength: length,
        sendOk: false,
        readOk: false,
        exactLength: false,
        exactContent: false,
        observedLength: null,
        latencyMs: Date.now() - sentAt,
        expectedFailure,
        error: errorMessage(error),
      });
    }
  }

  let hasFail = false;
  let hasWarn = false;
  for (const result of results) {
    if (result.expectedFailure) {
      if (result.sendOk) hasWarn = true;
      continue;
    }

    if (!result.sendOk || !result.readOk || !result.exactLength || !result.exactContent) {
      hasFail = true;
    }
  }

  if (hasFail) return { status: 'fail', results };
  if (hasWarn) return { status: 'warn', results };
  return { status: 'ok', results };
}

export async function diagnoseCommand(options: DiagnoseCommandOptions = {}): Promise<void> {
  try {
    validateConfig();
  } catch (error) {
    console.log(chalk.red(`❌ Config validation failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(
      buildDiagnoseStatusCodeLine({
        result: 'fail',
        probeStatus: 'skipped',
        ioBoundaryStatus: 'not-run',
        patternCount: 0,
        criticalPatterns: true,
        newPatternCount: 0,
      }),
    );
    return;
  }

  const platform = config.messagingPlatform || 'discord';
  if (platform !== 'discord') {
    console.log(chalk.yellow('⚠️ `mudcode diagnose` currently supports Discord only.'));
    console.log(
      buildDiagnoseStatusCodeLine({
        result: 'fail',
        probeStatus: 'skipped',
        ioBoundaryStatus: 'not-run',
        patternCount: 0,
        criticalPatterns: true,
        newPatternCount: 0,
      }),
    );
    return;
  }

  const token = config.discord.token?.trim();
  if (!token) {
    console.log(chalk.red('Discord token is not configured.'));
    console.log(
      buildDiagnoseStatusCodeLine({
        result: 'fail',
        probeStatus: 'skipped',
        ioBoundaryStatus: 'not-run',
        patternCount: 0,
        criticalPatterns: true,
        newPatternCount: 0,
      }),
    );
    return;
  }

  const target = resolveTargetChannel(options);
  if (!target) {
    console.log(chalk.red('Could not resolve a diagnostic target channel.'));
    console.log(chalk.gray('Provide --channel, or --project [--instance], or set config --channel.'));
    console.log(
      buildDiagnoseStatusCodeLine({
        result: 'fail',
        probeStatus: 'skipped',
        ioBoundaryStatus: 'not-run',
        patternCount: 0,
        criticalPatterns: true,
        newPatternCount: 0,
      }),
    );
    return;
  }

  const lookback = clampInt(options.lookback, 80, 10, 200);
  const timeoutMs = clampInt(options.timeoutMs, 15000, 3000, 120000);
  const runProbe = !options.skipProbe;
  const runIOBoundary = !!options.ioBoundary;
  const includeOversize = !!options.includeOversize;

  console.log(chalk.cyan('\n🧪 Mudcode Diagnose (Discord E2E)\n'));
  console.log(chalk.gray(`Target channel: ${target.channelId} (${target.source})`));
  console.log(chalk.gray(`History lookback: ${lookback} messages`));
  console.log(chalk.gray(`Probe mode: ${runProbe ? `enabled (${timeoutMs}ms timeout)` : 'disabled'}`));
  if (runIOBoundary) {
    console.log(chalk.gray(`I/O boundary mode: enabled (${getBoundaryProbeLengths(includeOversize).join(', ')} chars)`));
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  try {
    await client.login(token);
    await once(client, 'ready');
    const botTag = client.user?.tag || client.user?.id || 'unknown-bot';
    const botId = client.user?.id || '';
    console.log(chalk.green(`✅ Discord auth ok (${botTag})`));

    const channel = await client.channels.fetch(target.channelId);
    if (
      !channel ||
      !channel.isTextBased() ||
      !('messages' in channel) ||
      !('send' in channel) ||
      typeof channel.send !== 'function'
    ) {
      console.log(chalk.red(`❌ Channel ${target.channelId} is not a readable text channel.`));
      console.log(
        buildDiagnoseStatusCodeLine({
          result: 'fail',
          probeStatus: 'skipped',
          ioBoundaryStatus: 'not-run',
          patternCount: 0,
          criticalPatterns: true,
          newPatternCount: 0,
        }),
      );
      return;
    }
    const textChannel = channel as DiagnosticTextChannel;

    if (textChannel.type !== ChannelType.GuildText && textChannel.type !== ChannelType.PublicThread && textChannel.type !== ChannelType.PrivateThread) {
      console.log(chalk.yellow(`⚠️ Channel type ${String(textChannel.type)} may limit send/read behavior.`));
    }

    const before = await textChannel.messages.fetch({ limit: lookback });
    const beforeBotTexts = [...before.values()]
      .filter((msg) => !botId || msg.author?.id === botId)
      .map((msg) => msg.content || '');
    const beforeIssues = analyzeDiagnosticMessages(beforeBotTexts);
    console.log(chalk.green(`✅ Channel read ok (bot history inspected: ${beforeBotTexts.length})`));

    let probeStatus = 'skipped';
    if (runProbe) {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const probeLine = `🧪 mudcode diagnose probe ${nonce}`;
      const sentAt = Date.now();
      const sent = await textChannel.send({ content: probeLine });

      let seen = false;
      while (Date.now() - sentAt < timeoutMs) {
        const page = await textChannel.messages.fetch({ limit: 30 });
        const found = page.get(sent.id) || [...page.values()].find((msg) => msg.content.includes(nonce));
        if (found) {
          seen = true;
          break;
        }
        await sleep(500);
      }

      if (seen) {
        probeStatus = `ok (${Date.now() - sentAt}ms)`;
        console.log(chalk.green(`✅ Probe send/read ok (${Date.now() - sentAt}ms)`));
      } else {
        probeStatus = 'failed-timeout';
        console.log(chalk.red(`❌ Probe message was sent but not observed in read-back within ${timeoutMs}ms.`));
      }
    }

    let ioBoundaryStatus: IOBoundaryStatus = 'not-run';
    if (runIOBoundary) {
      const boundary = await runIOBoundaryProbe(textChannel, timeoutMs, includeOversize);
      ioBoundaryStatus = boundary.status;

      for (const result of boundary.results) {
        const observed = result.observedLength === null ? '-' : String(result.observedLength);
        if (result.expectedFailure) {
          if (result.sendOk) {
            console.log(chalk.yellow(`- ${result.targetLength}: send=ok (expected rejection) observed=${observed}`));
          } else {
            console.log(chalk.green(`- ${result.targetLength}: expected rejection ok (${result.error || 'rejected'})`));
          }
          continue;
        }

        const verdict = result.sendOk && result.readOk && result.exactLength && result.exactContent ? chalk.green('ok') : chalk.red('fail');
        const latency = result.latencyMs === null ? '-' : `${result.latencyMs}ms`;
        const detail = result.error ? ` err="${result.error}"` : '';
        console.log(
          `${verdict} - ${result.targetLength}: send=${result.sendOk ? 'ok' : 'fail'} read=${result.readOk ? 'ok' : 'fail'} exactLen=${result.exactLength ? 'ok' : 'fail'} exactBody=${result.exactContent ? 'ok' : 'fail'} observed=${observed} latency=${latency}${detail}`,
        );
      }
    }

    const after = await textChannel.messages.fetch({ limit: lookback });
    const afterBotTexts = [...after.values()]
      .filter((msg) => !botId || msg.author?.id === botId)
      .map((msg) => msg.content || '');
    const issues = analyzeDiagnosticMessages(afterBotTexts);

    if (issues.length === 0) {
      console.log(chalk.green('✅ No known warning/error patterns found in recent bot messages.'));
    } else {
      console.log(chalk.yellow('\nDetected patterns:'));
      for (const issue of issues) {
        console.log(chalk.yellow(`- ${issue.label}: ${issue.count}`));
      }
    }

    const newlySeen = issues
      .map((issue) => issue.count - (beforeIssues.find((x) => x.code === issue.code)?.count || 0))
      .reduce((sum, value) => sum + Math.max(0, value), 0);
    const hasCritical = issues.some((issue) => ['delivery-failed', 'mapping-missing', 'project-missing'].includes(issue.code));
    const result: DiagnoseResultStatus =
      probeStatus === 'failed-timeout' || hasCritical || ioBoundaryStatus === 'fail'
        ? 'fail'
        : issues.length > 0 || newlySeen > 0 || ioBoundaryStatus === 'warn'
          ? 'warn'
          : 'ok';

    console.log(chalk.cyan('\nSummary:'));
    if (result === 'fail') {
      console.log(chalk.red(`diagnose result = fail (${probeStatus}, io-boundary=${ioBoundaryStatus}, critical-patterns=${hasCritical ? 'yes' : 'no'})`));
    } else if (result === 'warn') {
      console.log(chalk.yellow(`diagnose result = warn (${probeStatus}, io-boundary=${ioBoundaryStatus}, patterns=${issues.length})`));
    } else {
      console.log(chalk.green(`diagnose result = ok (${probeStatus}, io-boundary=${ioBoundaryStatus})`));
    }
    console.log(
      buildDiagnoseStatusCodeLine({
        result,
        probeStatus,
        ioBoundaryStatus,
        patternCount: issues.length,
        criticalPatterns: hasCritical,
        newPatternCount: newlySeen,
      }),
    );
  } catch (error) {
    console.log(chalk.red(`❌ Diagnose failed: ${error instanceof Error ? error.message : String(error)}`));
    console.log(
      buildDiagnoseStatusCodeLine({
        result: 'fail',
        probeStatus: 'failed-exception',
        ioBoundaryStatus: 'not-run',
        patternCount: 0,
        criticalPatterns: true,
        newPatternCount: 0,
      }),
    );
  } finally {
    await client.destroy();
  }
}
