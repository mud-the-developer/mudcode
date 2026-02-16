import { beforeEach, describe, expect, it, vi } from 'vitest';

const installerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn(),
  installClaudePlugin: vi.fn(),
  installGeminiHook: vi.fn(),
  installCodexHook: vi.fn(),
}));

vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: installerMocks.installOpencodePlugin,
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: installerMocks.installClaudePlugin,
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: installerMocks.installGeminiHook,
}));

vi.mock('../../src/codex/plugin-installer.js', () => ({
  installCodexHook: installerMocks.installCodexHook,
}));

import { installAgentIntegration } from '../../src/policy/agent-integration.js';

describe('agent integration policy', () => {
  beforeEach(() => {
    installerMocks.installOpencodePlugin.mockReset();
    installerMocks.installClaudePlugin.mockReset();
    installerMocks.installGeminiHook.mockReset();
    installerMocks.installCodexHook.mockReset();
  });

  it('returns claude plugin dir and event hook on success', () => {
    installerMocks.installClaudePlugin.mockReturnValue('/mock/claude/plugin');

    const result = installAgentIntegration('claude', '/project', 'install');

    expect(result.eventHookInstalled).toBe(true);
    expect(result.claudePluginDir).toBe('/mock/claude/plugin');
    expect(result.infoMessages).toContain('🪝 Installed Claude Code plugin: /mock/claude/plugin');
    expect(result.warningMessages).toHaveLength(0);
  });

  it('returns warning and no hook on failure', () => {
    installerMocks.installCodexHook.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const result = installAgentIntegration('codex', '/project', 'reinstall');

    expect(result.eventHookInstalled).toBe(false);
    expect(result.infoMessages).toHaveLength(0);
    expect(result.warningMessages).toContain('Could not reinstall Codex notify hook: permission denied');
  });
});
