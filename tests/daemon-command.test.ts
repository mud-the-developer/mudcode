import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureDaemonRunning: vi.fn(),
  getDaemonStatus: vi.fn(),
  stopDaemon: vi.fn(),
  ensureTmuxInstalled: vi.fn(),
  stateManager: {
    listProjects: vi.fn(),
  },
  tmuxManagerInstance: {
    listSessions: vi.fn(),
    sessionExistsFull: vi.fn(),
    killSession: vi.fn(),
  },
  TmuxManager: vi.fn(),
  config: {
    tmux: {
      sessionPrefix: 'agent-',
    },
  },
}));

vi.mock('../src/app/daemon-service.js', () => ({
  ensureDaemonRunning: mocks.ensureDaemonRunning,
  getDaemonStatus: mocks.getDaemonStatus,
  stopDaemon: mocks.stopDaemon,
}));

vi.mock('../src/cli/common/tmux.js', () => ({
  ensureTmuxInstalled: mocks.ensureTmuxInstalled,
}));

vi.mock('../src/state/index.js', () => ({
  stateManager: mocks.stateManager,
}));

vi.mock('../src/tmux/manager.js', () => ({
  TmuxManager: mocks.TmuxManager,
}));

vi.mock('../src/config/index.js', () => ({
  config: mocks.config,
}));

describe('daemonCommand restart action', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mocks.getDaemonStatus.mockResolvedValue({
      running: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
      pidFile: '/tmp/daemon.pid',
    });
    mocks.stopDaemon.mockReturnValue(true);
    mocks.ensureDaemonRunning.mockResolvedValue({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/tmp/daemon.log',
    });
    mocks.stateManager.listProjects.mockReturnValue([]);
    mocks.tmuxManagerInstance.listSessions.mockReturnValue([]);
    mocks.tmuxManagerInstance.sessionExistsFull.mockReturnValue(true);
    mocks.tmuxManagerInstance.killSession.mockReturnValue(undefined);
    mocks.TmuxManager.mockImplementation(function MockTmuxManager() {
      return mocks.tmuxManagerInstance;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('restarts daemon when already running', async () => {
    const { daemonCommand } = await import('../src/cli/commands/daemon.js');

    await daemonCommand('restart');

    expect(mocks.ensureTmuxInstalled).toHaveBeenCalledOnce();
    expect(mocks.getDaemonStatus).toHaveBeenCalledOnce();
    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(mocks.ensureDaemonRunning).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Daemon restarted'));
  });

  it('starts daemon when restart is requested but daemon is not running', async () => {
    mocks.getDaemonStatus.mockResolvedValue({
      running: false,
      port: 18470,
      logFile: '/tmp/daemon.log',
      pidFile: '/tmp/daemon.pid',
    });

    const { daemonCommand } = await import('../src/cli/commands/daemon.js');

    await daemonCommand('restart');

    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    expect(mocks.ensureDaemonRunning).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Daemon started'));
  });

  it('does not start a second daemon when stop fails during restart', async () => {
    mocks.stopDaemon.mockReturnValue(false);

    const { daemonCommand } = await import('../src/cli/commands/daemon.js');

    await daemonCommand('restart');

    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(mocks.ensureDaemonRunning).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Could not stop daemon for restart'));
  });

  it('clears managed tmux sessions when restart is requested with clearSession', async () => {
    mocks.stateManager.listProjects.mockReturnValue([
      { tmuxSession: 'agent-bridge' },
      { tmuxSession: 'agent-demo' },
    ]);
    mocks.tmuxManagerInstance.listSessions.mockReturnValue([
      { name: 'agent-bridge' },
      { name: 'agent-other' },
    ]);
    mocks.tmuxManagerInstance.sessionExistsFull.mockImplementation((sessionName: string) => sessionName !== 'agent-other');

    const { daemonCommand } = await import('../src/cli/commands/daemon.js');

    await daemonCommand('restart', { clearSession: true });

    expect(mocks.TmuxManager).toHaveBeenCalledOnce();
    expect(mocks.tmuxManagerInstance.killSession).toHaveBeenCalledTimes(2);
    expect(mocks.tmuxManagerInstance.killSession).toHaveBeenCalledWith('agent-bridge');
    expect(mocks.tmuxManagerInstance.killSession).toHaveBeenCalledWith('agent-demo');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cleared 2 tmux session(s)'));
  });
});
