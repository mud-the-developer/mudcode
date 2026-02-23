import { describe, expect, it } from 'vitest';
import { buildAgentLaunchEnv, buildExportPrefix, withClaudePluginDir } from '../../src/policy/agent-launch.js';

describe('agent launch policy', () => {
  it('builds shell export prefix with escaping', () => {
    const prefix = buildExportPrefix({
      A: 'alpha',
      B: "it's",
      EMPTY: undefined,
    });

    expect(prefix).toBe("export A='alpha'; export B='it'\\''s'; ");
  });

  it('injects claude plugin dir only for claude command token', () => {
    const command = 'cd "/tmp/claude" && claude --print';
    const next = withClaudePluginDir(command, '/plugins/claude');

    expect(next).toContain("claude --plugin-dir '/plugins/claude' --print");
  });

  it('builds launch env with optional opencode permission', () => {
    const withoutPermission = buildAgentLaunchEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
      permissionAllow: false,
    });
    expect(withoutPermission.OPENCODE_PERMISSION).toBeUndefined();
    expect(withoutPermission.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();

    const withPermission = buildAgentLaunchEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'opencode',
      instanceId: 'opencode',
      permissionAllow: true,
    });
    expect(withPermission.OPENCODE_PERMISSION).toBe('{"*":"allow"}');

    const codexEnv = buildAgentLaunchEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'codex',
      instanceId: 'codex',
      permissionAllow: false,
    });
    expect(codexEnv.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
  });

  it('allows overriding codex sandbox network flag via environment variable', () => {
    const previous = process.env.MUDCODE_CODEX_SANDBOX_NETWORK_DISABLED;
    try {
      process.env.MUDCODE_CODEX_SANDBOX_NETWORK_DISABLED = '1';
      const codexEnv = buildAgentLaunchEnv({
        projectName: 'my-project',
        port: 18470,
        agentType: 'codex',
        instanceId: 'codex',
        permissionAllow: false,
      });

      expect(codexEnv.CODEX_SANDBOX_NETWORK_DISABLED).toBe('1');
    } finally {
      process.env.MUDCODE_CODEX_SANDBOX_NETWORK_DISABLED = previous;
    }
  });
});
