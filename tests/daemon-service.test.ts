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

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.DISCODE_DAEMON_RUNTIME;
    delete process.env.DISCODE_RS_BIN;
    delete process.env.DISCODE_RS_MANIFEST;

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

  it('uses explicit Rust binary when DISCODE_DAEMON_RUNTIME=rust and DISCODE_RS_BIN is set', async () => {
    process.env.DISCODE_DAEMON_RUNTIME = 'rust';
    process.env.DISCODE_RS_BIN = '/custom/bin/discode-rs';

    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith({
      command: '/custom/bin/discode-rs',
      args: [],
    });
  });

  it('falls back to cargo run when Rust manifest is available', async () => {
    process.env.DISCODE_DAEMON_RUNTIME = 'rust';
    process.env.DISCODE_RS_MANIFEST = '/repo/discode-rs/Cargo.toml';

    hoisted.existsSync.mockImplementation((candidate: string) => candidate === '/repo/discode-rs/Cargo.toml');

    const mod = await import('../src/app/daemon-service.js');

    await mod.ensureDaemonRunning();

    expect(hoisted.defaultDaemonManager.startDaemon).toHaveBeenCalledWith({
      command: 'cargo',
      args: ['run', '--manifest-path', '/repo/discode-rs/Cargo.toml', '--quiet'],
    });
  });
});
