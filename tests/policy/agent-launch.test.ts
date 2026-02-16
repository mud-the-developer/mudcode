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

    const withPermission = buildAgentLaunchEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'opencode',
      instanceId: 'opencode',
      permissionAllow: true,
    });
    expect(withPermission.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });
});
