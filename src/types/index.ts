/**
 * TypeScript type definitions
 */

export * from './interfaces.js';

export interface DiscordConfig {
  token: string;
  channelId?: string;
  guildId?: string;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: Date;
}

export interface AgentMessage {
  type: 'tool-output' | 'agent-output' | 'error';
  content: string;
  timestamp: Date;
  sessionName?: string;
  agentName?: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
}

export type MessagingPlatform = 'discord' | 'slack';

export interface BridgeConfig {
  discord: DiscordConfig;
  slack?: SlackConfig;
  /** Which messaging platform to use. Defaults to 'discord'. */
  messagingPlatform?: MessagingPlatform;
  promptRefiner?: {
    /**
     * Prompt refiner execution mode.
     * - off: disable refiner and keep raw sanitized input
     * - shadow: compute refined candidate and log it, but send raw input
     * - enforce: send refined candidate
     */
    mode?: 'off' | 'shadow' | 'enforce';
    /**
     * JSONL output path for shadow/enforce refinement logs.
     */
    logPath?: string;
    /**
     * Maximum characters saved for baseline/candidate in each log entry.
     */
    maxLogChars?: number;
  };
  tmux: {
    sessionPrefix: string;
    /**
     * Shared tmux session name without prefix.
     * Full session name becomes `${sessionPrefix}${sharedSessionName}`.
     */
    sharedSessionName?: string;
  };
  capture?: {
    /**
     * Capture poll interval in milliseconds.
     * Equivalent to AGENT_DISCORD_CAPTURE_POLL_MS.
     */
    pollMs?: number;
    /**
     * Number of quiet polls before marking pending completion after output appears.
     * Equivalent to AGENT_DISCORD_CAPTURE_PENDING_QUIET_POLLS.
     */
    pendingQuietPolls?: number;
    /**
     * Number of quiet polls before marking initial codex completion when no output has appeared yet.
     * Equivalent to AGENT_DISCORD_CAPTURE_PENDING_INITIAL_QUIET_POLLS_CODEX.
     */
    pendingInitialQuietPollsCodex?: number;
    /**
     * Keep codex output buffered and send only final consolidated result.
     * Equivalent to AGENT_DISCORD_CAPTURE_CODEX_FINAL_ONLY.
     */
    codexFinalOnly?: boolean;
    /**
     * Stale pending alert threshold in milliseconds.
     * Equivalent to AGENT_DISCORD_CAPTURE_STALE_ALERT_MS.
     */
    staleAlertMs?: number;
    /**
     * Remove pending prompt echo text from capture deltas.
     * Equivalent to AGENT_DISCORD_CAPTURE_FILTER_PROMPT_ECHO.
     */
    filterPromptEcho?: boolean;
    /**
     * Maximum suppressed prompt-echo polls before fallback.
     * Equivalent to AGENT_DISCORD_CAPTURE_PROMPT_ECHO_MAX_POLLS.
     */
    promptEchoMaxPolls?: number;
    /**
     * tmux capture history depth (number of lines from bottom).
     * Equivalent to AGENT_DISCORD_CAPTURE_HISTORY_LINES.
     */
    historyLines?: number;
    /**
     * Fallback tail lines for full-screen redraw deltas.
     * Equivalent to AGENT_DISCORD_CAPTURE_REDRAW_TAIL_LINES.
     */
    redrawTailLines?: number;
    /**
     * Threshold for thread-based long output delivery.
     * Equivalent to AGENT_DISCORD_LONG_OUTPUT_THREAD_THRESHOLD.
     */
    longOutputThreadThreshold?: number;
  };
  hookServerPort?: number;
  /**
   * Preferred AI CLI for `mudcode new` when agent is not explicitly specified.
   */
  defaultAgentCli?: string;
  opencode?: {
    /**
     * OpenCode permission mode applied at launch time.
     * - 'allow': set OPENCODE_PERMISSION='{"*":"allow"}' for launched OpenCode sessions.
     * - 'default': do not override OpenCode permission behavior.
     */
    permissionMode?: 'allow' | 'default';
  };
}

export interface ProjectAgents {
  [agentType: string]: boolean;
}

export interface ProjectInstanceState {
  instanceId: string;
  agentType: string;
  tmuxWindow?: string;
  /** Platform-agnostic channel ID (Discord channel ID or Slack channel ID). */
  channelId?: string;
  eventHook?: boolean;
}

export interface ProjectState {
  projectName: string;
  projectPath: string;
  tmuxSession: string;
  /**
   * Multi-instance state keyed by instance ID.
   *
   * Example keys:
   * - "gemini"
   * - "gemini-2"
   */
  instances?: {
    [instanceId: string]: ProjectInstanceState | undefined;
  };
  /**
   * Optional mapping from agentType -> tmux window target.
   *
   * Examples:
   * - `gemini` (window name; manager will target pane `.0`)
   * - `gemini.1` (explicit pane target)
   *
   * If omitted, agentType is treated as the window name (legacy behavior).
   */
  tmuxWindows?: {
    [agentType: string]: string | undefined;
  };
  /**
   * Optional mapping from agentType -> whether outbound Discord messages are
   * delivered by agent-native event hooks.
   */
  eventHooks?: {
    [agentType: string]: boolean | undefined;
  };
  discordChannels: {
    [agentType: string]: string | undefined;
  };
  agents: ProjectAgents;
  createdAt: Date;
  lastActive: Date;
}

/**
 * Platform-agnostic message attachment (image, file, etc.)
 */
export interface MessageAttachment {
  /** CDN / download URL for the attachment */
  url: string;
  /** Original filename (e.g. "screenshot.png") */
  filename: string;
  /** MIME content type (e.g. "image/png") */
  contentType: string | null;
  /** File size in bytes */
  size: number;
  /** Optional auth headers required to download (e.g. Slack Bearer token) */
  authHeaders?: Record<string, string>;
}

/** File MIME types that agents can process */
export const SUPPORTED_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/json',
  'text/plain',
] as const;

export type AgentType = string;
