import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TmuxManager } from '../../src/tmux/manager.js';

const hasTmux = (() => {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const shouldRun = hasTmux && process.env.MUDCODE_E2E_TMUX === '1';
const describeIf = shouldRun ? describe : describe.skip;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killSessionIfExists(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
  } catch {
    // Ignore missing session errors.
  }
}

function extractLastLengthMarker(captured: string): number | undefined {
  const matches = [...captured.matchAll(/__LEN__(\d+)/g)];
  if (matches.length === 0) return undefined;
  const value = matches[matches.length - 1]?.[1];
  return value ? Number(value) : undefined;
}

async function waitForCapture(
  tmux: TmuxManager,
  sessionName: string,
  windowName: string,
  predicate: (capture: string) => boolean,
  timeoutMs: number = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastCapture = '';
  while (Date.now() < deadline) {
    lastCapture = tmux.capturePaneFromWindow(sessionName, windowName);
    if (predicate(lastCapture)) return lastCapture;
    await wait(120);
  }
  throw new Error(`Timed out waiting for capture condition. Last capture tail:\n${lastCapture.slice(-600)}`);
}

describeIf('TmuxManager integration (real tmux)', () => {
  let tmux: TmuxManager;
  let sessionName: string;

  beforeEach(() => {
    tmux = new TmuxManager('');
    sessionName = `mudcode_e2e_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
    killSessionIfExists(sessionName);
    delete process.env.AGENT_DISCORD_CAPTURE_HISTORY_LINES;
  });

  afterEach(() => {
    killSessionIfExists(sessionName);
    delete process.env.AGENT_DISCORD_CAPTURE_HISTORY_LINES;
  });

  it('sends full long input and submits Enter in one delivery', async () => {
    tmux.createSession(sessionName, 'input-check');

    const lengthProbeCmd =
      "bash -lc 'stty -echo -icanon min 0 time 5; echo __LEN__$(dd bs=1 count=10000 status=none | wc -c); stty sane'";
    tmux.sendKeysToWindow(sessionName, 'input-check', lengthProbeCmd);
    await wait(250);

    const payload = 'x'.repeat(10_000);
    tmux.sendKeysToWindow(sessionName, 'input-check', payload);

    const captured = await waitForCapture(
      tmux,
      sessionName,
      'input-check',
      (snapshot) => /__LEN__\d+/.test(snapshot),
      5000,
    );
    const observed = extractLastLengthMarker(captured);
    expect(observed).toBe(payload.length);
  }, 15_000);

  it('sends full long input when typing and Enter are split', async () => {
    tmux.createSession(sessionName, 'split-submit-check');

    const lengthProbeCmd =
      "bash -lc 'stty -echo -icanon min 0 time 5; echo __LEN__$(dd bs=1 count=10000 status=none | wc -c); stty sane'";
    tmux.sendKeysToWindow(sessionName, 'split-submit-check', lengthProbeCmd);
    await wait(250);

    const payload = 'y'.repeat(10_000);
    tmux.typeKeysToWindow(sessionName, 'split-submit-check', payload);
    await wait(60);
    tmux.sendEnterToWindow(sessionName, 'split-submit-check');

    const captured = await waitForCapture(
      tmux,
      sessionName,
      'split-submit-check',
      (snapshot) => /__LEN__\d+/.test(snapshot),
      5000,
    );
    const observed = extractLastLengthMarker(captured);
    expect(observed).toBe(payload.length);
  }, 15_000);

  it('captures scrollback beyond viewport by default', async () => {
    tmux.createSession(sessionName, 'history-check');

    const burstCmd = 'i=1; while [ "$i" -le 140 ]; do printf "__HLINE__%03d\\n" "$i"; i=$((i+1)); done';
    tmux.sendKeysToWindow(sessionName, 'history-check', burstCmd);

    const captured = await waitForCapture(
      tmux,
      sessionName,
      'history-check',
      (snapshot) => snapshot.includes('__HLINE__140'),
      5000,
    );
    expect(captured).toContain('__HLINE__005');
    expect(captured).toContain('__HLINE__140');
  });
});
