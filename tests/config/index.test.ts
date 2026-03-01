/**
 * Tests for ConfigManager
 */

import { ConfigManager, type StoredConfig } from '../../src/config/index.js';
import type { IStorage, IEnvironment } from '../../src/types/interfaces.js';

// Mock storage implementation for testing
class MockStorage implements IStorage {
  private files: Map<string, string> = new Map();
  private dirs: Set<string> = new Set();

  readFile(path: string, _encoding: string): string {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    return content;
  }

  writeFile(path: string, data: string): void {
    this.files.set(path, data);
  }

  chmod(_path: string, _mode: number): void {}

  exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  mkdirp(path: string): void {
    this.dirs.add(path);
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  openSync(_path: string, _flags: string): number {
    return 0;
  }

  // Test helper
  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }
}

// Mock environment implementation for testing
class MockEnvironment implements IEnvironment {
  private vars: Map<string, string> = new Map();

  get(key: string): string | undefined {
    return this.vars.get(key);
  }

  homedir(): string {
    return '/mock/home';
  }

  platform(): string {
    return 'linux';
  }

  // Test helper
  set(key: string, value: string): void {
    this.vars.set(key, value);
  }
}

describe('ConfigManager', () => {
  const configDir = '/test/config';
  const configFile = '/test/config/config.json';

  describe('initialization and defaults', () => {
    it('returns default config when no file and no env vars', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      const config = manager.config;

      expect(config.discord.token).toBe('');
      expect(config.discord.channelId).toBeUndefined();
      expect(config.discord.guildId).toBeUndefined();
      expect(config.tmux.sessionPrefix).toBe('');
      expect(config.defaultAgentCli).toBeUndefined();
      expect(config.hookServerPort).toBe(18470);
      expect(config.promptRefiner).toBeUndefined();
    });

    it('loads token from stored config file', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const storedConfig: StoredConfig = {
        token: 'stored-token-123',
        channelId: 'stored-channel-123',
        serverId: 'stored-guild-456',
        tmuxTransport: 'ssh',
        tmuxSshTarget: 'user@remote',
        tmuxSshIdentity: '/home/test/.ssh/id_ed25519',
        tmuxSshPort: 2222,
        hookServerPort: 9999,
        defaultAgentCli: 'gemini',
        opencodePermissionMode: 'allow',
        promptRefinerMode: 'shadow',
        promptRefinerLogPath: '/tmp/shadow-log.jsonl',
        promptRefinerMaxLogChars: 9000,
        capturePollMs: 1200,
        capturePendingQuietPolls: 3,
        capturePendingInitialQuietPollsCodex: 0,
        captureCodexFinalOnly: true,
        captureStaleAlertMs: 75000,
        captureFilterPromptEcho: true,
        capturePromptEchoMaxPolls: 2,
        captureHistoryLines: 1800,
        captureRedrawTailLines: 120,
        longOutputThreadThreshold: 2500,
        captureProgressOutput: 'thread',
      };
      storage.setFile(configFile, JSON.stringify(storedConfig));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.discord.token).toBe('stored-token-123');
      expect(config.discord.channelId).toBe('stored-channel-123');
      expect(config.discord.guildId).toBe('stored-guild-456');
      expect(config.tmux.transport).toBe('ssh');
      expect(config.tmux.sshTarget).toBe('user@remote');
      expect(config.tmux.sshIdentity).toBe('/home/test/.ssh/id_ed25519');
      expect(config.tmux.sshPort).toBe(2222);
      expect(config.hookServerPort).toBe(9999);
      expect(config.defaultAgentCli).toBe('gemini');
      expect(config.opencode?.permissionMode).toBe('allow');
      expect(config.promptRefiner?.mode).toBe('shadow');
      expect(config.promptRefiner?.logPath).toBe('/tmp/shadow-log.jsonl');
      expect(config.promptRefiner?.maxLogChars).toBe(9000);
      expect(config.capture?.pollMs).toBe(1200);
      expect(config.capture?.pendingQuietPolls).toBe(3);
      expect(config.capture?.pendingInitialQuietPollsCodex).toBe(0);
      expect(config.capture?.codexFinalOnly).toBe(true);
      expect(config.capture?.staleAlertMs).toBe(75000);
      expect(config.capture?.filterPromptEcho).toBe(true);
      expect(config.capture?.promptEchoMaxPolls).toBe(2);
      expect(config.capture?.historyLines).toBe(1800);
      expect(config.capture?.redrawTailLines).toBe(120);
      expect(config.capture?.longOutputThreadThreshold).toBe(2500);
      expect(config.capture?.progressOutput).toBe('thread');
    });

    it('falls back to env var when no stored config', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'env-token-789');
      env.set('DISCORD_CHANNEL_ID', 'env-channel-789');
      env.set('DISCORD_GUILD_ID', 'env-guild-abc');
      env.set('HOOK_SERVER_PORT', '7777');
      env.set('TMUX_TRANSPORT', 'ssh');
      env.set('TMUX_SSH_TARGET', 'user@env-host');
      env.set('TMUX_SSH_PORT', '2201');
      env.set('MUDCODE_PROMPT_REFINER_MODE', 'shadow');
      env.set('MUDCODE_PROMPT_REFINER_LOG_PATH', '/tmp/env-shadow-log.jsonl');
      env.set('MUDCODE_PROMPT_REFINER_MAX_LOG_CHARS', '7000');
      env.set('AGENT_DISCORD_CAPTURE_POLL_MS', '1500');
      env.set('AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS', '4');
      env.set('AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX', '1');
      env.set('AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY', 'true');
      env.set('AGENT_DISCORD_CAPTURE_STALE_ALERT_MS', '90000');
      env.set('AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO', 'false');
      env.set('AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS', '5');
      env.set('AGENT_DISCORD_CAPTURE_HISTORY_LINES', '2000');
      env.set('AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES', '140');
      env.set('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD', '3000');
      env.set('AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT', 'off');

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.discord.token).toBe('env-token-789');
      expect(config.discord.channelId).toBe('env-channel-789');
      expect(config.discord.guildId).toBe('env-guild-abc');
      expect(config.tmux.transport).toBe('ssh');
      expect(config.tmux.sshTarget).toBe('user@env-host');
      expect(config.tmux.sshPort).toBe(2201);
      expect(config.hookServerPort).toBe(7777);
      expect(config.promptRefiner?.mode).toBe('shadow');
      expect(config.promptRefiner?.logPath).toBe('/tmp/env-shadow-log.jsonl');
      expect(config.promptRefiner?.maxLogChars).toBe(7000);
      expect(config.capture?.pollMs).toBe(1500);
      expect(config.capture?.pendingQuietPolls).toBe(4);
      expect(config.capture?.pendingInitialQuietPollsCodex).toBe(1);
      expect(config.capture?.codexFinalOnly).toBe(true);
      expect(config.capture?.staleAlertMs).toBe(90000);
      expect(config.capture?.filterPromptEcho).toBe(false);
      expect(config.capture?.promptEchoMaxPolls).toBe(5);
      expect(config.capture?.historyLines).toBe(2000);
      expect(config.capture?.redrawTailLines).toBe(140);
      expect(config.capture?.longOutputThreadThreshold).toBe(3000);
      expect(config.capture?.progressOutput).toBe('off');
    });

    it('stored config takes priority over env vars', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();

      // Set env vars
      env.set('DISCORD_BOT_TOKEN', 'env-token');
      env.set('DISCORD_CHANNEL_ID', 'env-channel');
      env.set('DISCORD_GUILD_ID', 'env-guild');

      // Set stored config (should win)
      const storedConfig: StoredConfig = {
        token: 'stored-token-wins',
        channelId: 'stored-channel-wins',
        serverId: 'stored-guild-wins',
      };
      storage.setFile(configFile, JSON.stringify(storedConfig));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.discord.token).toBe('stored-token-wins');
      expect(config.discord.channelId).toBe('stored-channel-wins');
      expect(config.discord.guildId).toBe('stored-guild-wins');
    });

    it('normalizes token from stored config and env', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', '  Bot env-token-123  ');
      storage.setFile(configFile, JSON.stringify({ token: '  "Bot stored-token-456"  ' }));

      const manager = new ConfigManager(storage, env, configDir);
      const config = manager.config;

      expect(config.discord.token).toBe('stored-token-456');
    });
  });

  describe('config persistence', () => {
    it('saveConfig writes to storage and invalidates cache', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      // Initial config has no token
      expect(manager.config.discord.token).toBe('');

      // Save a new token
      manager.saveConfig({ token: 'new-saved-token' });

      // Config should be invalidated and reloaded with new token
      expect(manager.config.discord.token).toBe('new-saved-token');

      // Verify it was persisted
      const savedData = storage.readFile(configFile, 'utf-8');
      const savedConfig = JSON.parse(savedData);
      expect(savedConfig.token).toBe('new-saved-token');
    });

    it('saveConfig normalizes token before writing', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      manager.saveConfig({ token: '  "Bot test-token-999"  ' });

      const savedData = storage.readFile(configFile, 'utf-8');
      const savedConfig = JSON.parse(savedData);
      expect(savedConfig.token).toBe('test-token-999');
    });

    it('getConfigValue reads specific key', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const storedConfig: StoredConfig = {
        token: 'my-token',
        channelId: 'my-channel',
        serverId: 'my-server',
        hookServerPort: 8888,
        opencodePermissionMode: 'default',
        promptRefinerMode: 'enforce',
      };
      storage.setFile(configFile, JSON.stringify(storedConfig));

      const manager = new ConfigManager(storage, env, configDir);

      expect(manager.getConfigValue('token')).toBe('my-token');
      expect(manager.getConfigValue('channelId')).toBe('my-channel');
      expect(manager.getConfigValue('serverId')).toBe('my-server');
      expect(manager.getConfigValue('hookServerPort')).toBe(8888);
      expect(manager.getConfigValue('opencodePermissionMode')).toBe('default');
      expect(manager.getConfigValue('promptRefinerMode')).toBe('enforce');
    });
  });

  describe('validation', () => {
    it('validateConfig throws when no token', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/Discord bot token not configured/);
    });

    it('validateConfig passes when token exists', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).not.toThrow();
    });

    it('validateConfig throws for invalid MESSAGING_PLATFORM value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('MESSAGING_PLATFORM', 'discrod');
      env.set('DISCORD_BOT_TOKEN', 'valid-token');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/MESSAGING_PLATFORM/);
    });

    it('validateConfig throws for invalid OPENCODE_PERMISSION_MODE value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('OPENCODE_PERMISSION_MODE', 'enabled');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/OPENCODE_PERMISSION_MODE/);
    });

    it('validateConfig throws for invalid TMUX_TRANSPORT value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('TMUX_TRANSPORT', 'remote');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/TMUX_TRANSPORT/);
    });

    it('validateConfig throws when TMUX_TRANSPORT=ssh without TMUX_SSH_TARGET', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('TMUX_TRANSPORT', 'ssh');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/TMUX_TRANSPORT=ssh requires TMUX_SSH_TARGET/);
    });

    it('validateConfig throws for invalid TMUX_SSH_PORT value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('TMUX_TRANSPORT', 'ssh');
      env.set('TMUX_SSH_TARGET', 'user@host');
      env.set('TMUX_SSH_PORT', '70000');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/TMUX_SSH_PORT/);
    });

    it('validateConfig throws for invalid MUDCODE_PROMPT_REFINER_MODE value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('MUDCODE_PROMPT_REFINER_MODE', 'enabled');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/MUDCODE_PROMPT_REFINER_MODE/);
    });

    it('validateConfig throws for invalid HOOK_SERVER_PORT value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('HOOK_SERVER_PORT', 'abc');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/HOOK_SERVER_PORT/);
    });

    it('validateConfig throws for invalid capture booleans', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY', 'sometimes');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY/);
    });

    it('validateConfig throws for invalid capture progress output value', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT', 'subthread');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/AGENT_DISCORD_CAPTURE_PROGRESS_OUTPUT/);
    });

    it('validateConfig auto-clamps legacy AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD from env', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD', '100000');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).not.toThrow();
      expect(manager.config.capture?.longOutputThreadThreshold).toBe(20000);
    });

    it('validateConfig migrates legacy stored longOutputThreadThreshold on load', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      storage.setFile(configFile, JSON.stringify({ longOutputThreadThreshold: 100000 }));

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).not.toThrow();
      expect(manager.config.capture?.longOutputThreadThreshold).toBe(20000);

      const savedData = storage.readFile(configFile, 'utf-8');
      const savedConfig = JSON.parse(savedData);
      expect(savedConfig.longOutputThreadThreshold).toBe(20000);
    });

    it('validateConfig still throws for AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD above legacy max', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD', '100001');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD/);
    });

    it('validateConfig ignores invalid env long-output threshold when stored value is valid', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      env.set('AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD', '100001');
      storage.setFile(configFile, JSON.stringify({ longOutputThreadThreshold: 20000 }));

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).not.toThrow();
      expect(manager.config.capture?.longOutputThreadThreshold).toBe(20000);
    });

    it('validateConfig throws for invalid stored capture polling values', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      storage.setFile(configFile, JSON.stringify({ capturePollMs: 100 }));

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/capturePollMs/);
    });

    it('validateConfig throws for invalid stored hookServerPort', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('DISCORD_BOT_TOKEN', 'valid-token');
      storage.setFile(configFile, JSON.stringify({ hookServerPort: 70000 }));

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/hookServerPort/);
    });

    it('validateConfig throws for malformed slack token formats when slack is enabled', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      env.set('MESSAGING_PLATFORM', 'slack');
      env.set('SLACK_BOT_TOKEN', 'bot-token');
      env.set('SLACK_APP_TOKEN', 'app-token');

      const manager = new ConfigManager(storage, env, configDir);

      expect(() => manager.validateConfig()).toThrow(/SLACK_BOT_TOKEN/);
    });
  });

  describe('utilities', () => {
    it('resetConfig clears cached config', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      // Access config to cache it
      expect(manager.config.discord.token).toBe('');

      // Set env var
      env.set('DISCORD_BOT_TOKEN', 'new-token-after-reset');

      // Without reset, cached config would still have empty token
      // With reset, it should re-read from env
      manager.resetConfig();

      expect(manager.config.discord.token).toBe('new-token-after-reset');
    });

    it('getConfigPath returns correct path', () => {
      const storage = new MockStorage();
      const env = new MockEnvironment();
      const manager = new ConfigManager(storage, env, configDir);

      expect(manager.getConfigPath()).toBe(configFile);
    });
  });
});
