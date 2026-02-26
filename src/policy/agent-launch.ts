import { escapeShellArg } from '../infra/shell-escape.js';

export function buildExportPrefix(env: Record<string, string | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`unset ${key}`);
      continue;
    }
    parts.push(`export ${key}=${escapeShellArg(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
}

export function withClaudePluginDir(command: string, pluginDir?: string): string {
  if (!pluginDir || pluginDir.length === 0) return command;
  if (/--plugin-dir\b/.test(command)) return command;
  const pattern = /((?:^|&&|;)\s*)claude\b/;
  if (!pattern.test(command)) return command;
  return command.replace(pattern, `$1claude --plugin-dir ${escapeShellArg(pluginDir)}`);
}

export function buildAgentLaunchEnv(params: {
  projectName: string;
  port: number;
  agentType: string;
  instanceId: string;
  permissionAllow: boolean;
}): Record<string, string | null> {
  const codexSandboxNetworkDisabled =
    params.agentType === 'codex' ? process.env.MUDCODE_CODEX_SANDBOX_NETWORK_DISABLED?.trim() : undefined;
  const codexSandboxNetworkValue =
    params.agentType !== 'codex'
      ? undefined
      : codexSandboxNetworkDisabled === undefined || codexSandboxNetworkDisabled.length === 0
        ? null
        : codexSandboxNetworkDisabled;

  return {
    AGENT_DISCORD_PROJECT: params.projectName,
    AGENT_DISCORD_PORT: String(params.port),
    AGENT_DISCORD_AGENT: params.agentType,
    AGENT_DISCORD_INSTANCE: params.instanceId,
    ...(params.agentType === 'codex' ? { CODEX_SANDBOX_NETWORK_DISABLED: codexSandboxNetworkValue ?? null } : {}),
    ...(params.permissionAllow ? { OPENCODE_PERMISSION: '{"*":"allow"}' } : {}),
  };
}
