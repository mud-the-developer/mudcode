import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, writeFileSync } from 'fs';

const mocks = vi.hoisted(() => ({
  runDoctor: vi.fn(),
  daemonCommand: vi.fn(),
  healthCommand: vi.fn(),
  stateManager: {
    listProjects: vi.fn(),
  },
}));

vi.mock('../../../src/cli/commands/doctor.js', () => ({
  runDoctor: mocks.runDoctor,
}));

vi.mock('../../../src/cli/commands/daemon.js', () => ({
  daemonCommand: mocks.daemonCommand,
}));

vi.mock('../../../src/cli/commands/health.js', () => ({
  healthCommand: mocks.healthCommand,
}));

vi.mock('../../../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

describe('repairCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let repairLockPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    repairLockPath = join(tmpdir(), `mudcode-repair-test-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.MUDCODE_REPAIR_LOCK_PATH = repairLockPath;
    delete process.env.MUDCODE_REPAIR_LOCK_WAIT_MS;
    delete process.env.MUDCODE_REPAIR_LOCK_STALE_MS;
    mocks.runDoctor.mockResolvedValue({
      ok: true,
      issues: [],
      fixes: [],
    });
    mocks.stateManager.listProjects.mockReturnValue([]);
    mocks.daemonCommand.mockResolvedValue(undefined);
    mocks.healthCommand.mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(repairLockPath, { recursive: true, force: true });
    delete process.env.MUDCODE_REPAIR_LOCK_PATH;
    delete process.env.MUDCODE_REPAIR_LOCK_WAIT_MS;
    delete process.env.MUDCODE_REPAIR_LOCK_STALE_MS;
    process.exitCode = undefined;
  });

  it('normalizes repair mode aliases', async () => {
    const { normalizeRepairMode } = await import('../../../src/cli/commands/repair.js');
    expect(normalizeRepairMode(undefined)).toBe('default');
    expect(normalizeRepairMode('')).toBe('default');
    expect(normalizeRepairMode('doctor')).toBe('doctor-only');
    expect(normalizeRepairMode('restart')).toBe('restart-only');
    expect(normalizeRepairMode('check')).toBe('verify');
    expect(normalizeRepairMode('full')).toBe('deep');
    expect(normalizeRepairMode('unknown')).toBeUndefined();
  });

  it('runs default repair as doctor + restart', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand();

    expect(mocks.runDoctor).toHaveBeenCalledWith({ fix: true });
    expect(mocks.daemonCommand).toHaveBeenCalledWith('restart');
    expect(mocks.healthCommand).not.toHaveBeenCalled();
  });

  it('runs doctor-only mode', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'doctor-only' });

    expect(mocks.runDoctor).toHaveBeenCalledWith({ fix: true });
    expect(mocks.daemonCommand).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
  });

  it('runs restart-only mode', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'restart-only' });

    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(mocks.daemonCommand).toHaveBeenCalledWith('restart');
    expect(mocks.healthCommand).not.toHaveBeenCalled();
  });

  it('runs verify mode', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'verify' });

    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(mocks.daemonCommand).not.toHaveBeenCalled();
    expect(mocks.healthCommand).toHaveBeenCalledWith({
      captureTest: true,
      captureTestPolls: 4,
      captureTestIntervalMs: 700,
    });
  });

  it('passes explicit project scope to verify mode', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'verify', project: 'demo' });

    expect(mocks.healthCommand).toHaveBeenCalledWith({
      captureTest: true,
      captureTestPolls: 4,
      captureTestIntervalMs: 700,
      project: 'demo',
    });
  });

  it('auto-resolves verify scope from current directory project', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      {
        projectName: 'demo',
      },
      {
        projectName: 'other',
      },
    ]);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/demo');

    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'verify' });

    expect(mocks.healthCommand).toHaveBeenCalledWith({
      captureTest: true,
      captureTestPolls: 4,
      captureTestIntervalMs: 700,
      project: 'demo',
    });

    cwdSpy.mockRestore();
  });

  it('runs deep mode in sequence doctor -> restart -> verify', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'deep' });

    expect(mocks.runDoctor).toHaveBeenCalledWith({ fix: true });
    expect(mocks.daemonCommand).toHaveBeenCalledWith('restart');
    expect(mocks.healthCommand).toHaveBeenCalledWith({
      captureTest: true,
      captureTestPolls: 4,
      captureTestIntervalMs: 700,
    });

    const doctorOrder = mocks.runDoctor.mock.invocationCallOrder[0];
    const restartOrder = mocks.daemonCommand.mock.invocationCallOrder[0];
    const verifyOrder = mocks.healthCommand.mock.invocationCallOrder[0];
    expect(doctorOrder).toBeLessThan(restartOrder);
    expect(restartOrder).toBeLessThan(verifyOrder);
  });

  it('aborts when doctor step reports failure', async () => {
    mocks.runDoctor.mockResolvedValue({
      ok: false,
      issues: [{ level: 'fail' }],
      fixes: [],
    });
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand();

    expect(mocks.daemonCommand).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects unknown mode', async () => {
    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand({ mode: 'wat' });

    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(mocks.daemonCommand).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails fast when repair lock is already held', async () => {
    mkdirSync(repairLockPath, { recursive: true });
    writeFileSync(join(repairLockPath, 'owner'), 'external-test-owner', 'utf8');
    process.env.MUDCODE_REPAIR_LOCK_WAIT_MS = '50';
    process.env.MUDCODE_REPAIR_LOCK_STALE_MS = '600000';

    const { repairCommand } = await import('../../../src/cli/commands/repair.js');
    await repairCommand();

    expect(mocks.runDoctor).not.toHaveBeenCalled();
    expect(mocks.daemonCommand).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
