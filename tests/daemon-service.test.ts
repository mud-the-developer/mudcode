import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const existsSync = vi.fn();
  const defaultDaemonManager = {
    getPort: vi.fn().mockReturnValue(18470),
    getLogFile: vi.fn().mockReturnValue('/tmp/daemon.log'),
    getPidFile: vi.fn().mockReturnValue('/tmp/daemon.pid'),
    isRunning: vi.fn().mockResolvedValue(false),
    startDaemon: vi.fn(),
    waitForReady: vi.fn().mockResolvedValue(true),
    stopDaemon: vi.fn().mockReturnValue(true),
  };

  return {
    existsSync,
    defaultDaemonManager,
  };
});

vi.mock('fs', () => ({
  existsSync: hoisted.existsSync,
}));

vi.mock('../src/daemon.js', () => ({
  defaultDaemonManager: hoisted.defaultDaemonManager,
}));

describe('daemon-service runtime selection', () => {
  const originalEnv = { ...process.env };
  const originalExecPath = process.execPath;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    delete process.env.MUDCODE_DAEMON_RUNTIME;
    delete process.env.MUDCODE_RS_BIN;
    delete process.env.MUDCODE_RS_MANIFEST;

    hoisted.defaultDaemonManager.getPort.mockReturnValue(18470);
    hoisted.defaultDaemonManager.getLogFile.mockReturnValue('/tmp/daemon.log');
    hoisted.defaultDaemonManager.isRunning.mockResolvedValue(false);
    hoisted.defaultDaemonManager.waitForReady.mockResolvedValue(true);
    hoisted.existsSync.mockReturnValue(true);
  });

  it('uses TypeScript daemon entry by default', async () => {
    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith(expect.any(String));
  });

  it('uses daemon-runner command when running from packaged mudcode executable', async () => {
    Object.defineProperty(process, 'execPath', { value: '/tmp/mudcode', configurable: true });
    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith({
      command: '/tmp/mudcode',
      args: ['daemon-runner'],
      keepAwakeOnMac: false,
    });
  });

  it('uses explicit Rust binary when MUDCODE_DAEMON_RUNTIME=rust and MUDCODE_RS_BIN is set', async () => {
    process.env.MUDCODE_DAEMON_RUNTIME = 'rust';
    process.env.MUDCODE_RS_BIN = '/custom/bin/mudcode-rs';

    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith({
      command: '/custom/bin/mudcode-rs',
      args: [],
    });
  });

  it('falls back to cargo run when Rust manifest is available', async () => {
    process.env.MUDCODE_DAEMON_RUNTIME = 'rust';
    process.env.MUDCODE_RS_MANIFEST = '/repo/mudcode-rs/Cargo.toml';

    hoisted.existsSync.mockImplementation((candidate: string) => candidate === '/repo/mudcode-rs/Cargo.toml');

    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith({
      command: 'cargo',
      args: ['run', '--manifest-path', '/repo/mudcode-rs/Cargo.toml', '--quiet'],
    });
  });
});
