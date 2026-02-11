# Discord Agent Bridge

[English](README.md) | [한국어](docs/README.ko.md)

Bridge AI agent CLIs to Discord for remote monitoring and collaboration.

> Derived from [DoBuDevel/discord-agent-bridge](https://github.com/DoBuDevel/discord-agent-bridge). This project preserves original authorship and builds on top of the upstream work.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-green.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/Tests-129%20passing-brightgreen.svg)](./tests)

## Overview

Discord Agent Bridge connects AI coding assistants (Claude Code, OpenCode) to Discord, enabling remote monitoring and collaboration. Watch your AI agents work in real-time through Discord channels, share progress with your team, and track multiple projects simultaneously.

The bridge uses a polling-based architecture that captures tmux pane content every 30 seconds, detects state changes, and streams updates to dedicated Discord channels. Each project gets its own channel, and a single global daemon manages all connections efficiently.

## Features

- **Multi-Agent Support**: Works with Claude Code and OpenCode
- **Auto-Discovery**: Automatically detects installed AI agents on your system
- **Real-Time Streaming**: Captures tmux output and streams to Discord every 30 seconds
- **Project Isolation**: Each project gets a dedicated Discord channel
- **Single Daemon**: One Discord bot connection manages all projects
- **Session Management**: Persistent tmux sessions survive disconnections
- **YOLO Mode**: Optional `--yolo` flag runs Claude Code with `--dangerously-skip-permissions`
- **Sandbox Mode**: Optional `--sandbox` flag runs Claude Code in isolated Docker container
- **Rich CLI**: Intuitive commands for setup, control, and monitoring
- **Type-Safe**: Written in TypeScript with dependency injection pattern
- **Well-Tested**: 129 unit tests with Vitest

## Supported Platforms

| Platform | Supported | Notes |
|----------|-----------|-------|
| **macOS** | Yes | Developed and tested |
| **Linux** | Expected | Should work (tmux-based), not yet tested |
| **Windows (WSL)** | Expected | Should work with tmux installed in WSL, not yet tested |
| **Windows (native)** | No | tmux is not available natively |

## Prerequisites

- **Bun**: Version 1.3 or higher
- **tmux**: Version 3.0 or higher
- **Discord Bot**: Create a bot following the [Discord Bot Setup Guide](docs/DISCORD_SETUP.md)
  - Required permissions: Send Messages, Manage Channels, Read Message History, Embed Links, Add Reactions
  - Required intents: Guilds, GuildMessages, MessageContent, GuildMessageReactions
- **AI Agent**: At least one of:
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [OpenCode](https://github.com/OpenCodeAI/opencode)

## Installation

### Global install

```bash
bun add -g agent-messenger-bridge
```

### From source

```bash
git clone https://github.com/siisee11/agent-messenger-bridge.git
cd agent-messenger-bridge
bun install
bun run build
bun link
```

## Quick Start

### 1. Setup Discord Bot

```bash
# One-time setup with your Discord bot token
agent-bridge setup YOUR_DISCORD_BOT_TOKEN
```

The `setup` command saves your token and auto-detects the Discord server ID. You can verify or change settings later:

```bash
agent-bridge config --show              # View current configuration
agent-bridge config --server SERVER_ID  # Change server ID manually
```

> **Note**: `setup` is required for initial configuration — it auto-detects the server ID by connecting to Discord. The `config` command only updates individual values without auto-detection.

### 2. Start Working

```bash
cd ~/projects/my-app

# Just run go — that's it!
agent-bridge go
```

`go` handles everything automatically: detects installed agents, starts the daemon, creates a Discord channel, launches the agent in tmux, and attaches you to the session.

```bash
agent-bridge go claude        # Specify an agent explicitly
agent-bridge go --yolo        # YOLO mode (skip permissions, Claude Code only)
agent-bridge go --sandbox     # Sandbox mode (Docker isolation, Claude Code only)
```

Your AI agent is now running in tmux, with output streaming to Discord every 30 seconds.

### Advanced: Step-by-Step Setup

For more control over project configuration, use `init` to set up the project separately:

```bash
cd ~/projects/my-app

# Initialize with a specific agent and custom channel description
agent-bridge init claude "My awesome application"

# Then start step-by-step:
agent-bridge daemon start    # Start global daemon
agent-bridge start          # Start this project
agent-bridge attach         # Attach to tmux session
```

## CLI Reference

### Global Commands

#### `setup <token>`

One-time setup: saves bot token, connects to Discord to auto-detect your server, and shows installed agents.

```bash
agent-bridge setup YOUR_BOT_TOKEN
```

The setup process will:
1. Save your bot token to `~/.agent-messenger-bridge/config.json`
2. Connect to Discord and detect which server(s) your bot is in
3. If the bot is in multiple servers, prompt you to select one
4. Save the server ID automatically

#### `daemon <action>`

Control the global daemon process.

```bash
agent-bridge daemon start    # Start daemon
agent-bridge daemon stop     # Stop daemon
agent-bridge daemon status   # Check daemon status
```

#### `list`

List all registered projects.

```bash
agent-bridge list
```

#### `agents`

List available AI agents detected on your system.

```bash
agent-bridge agents
```

#### `tui`

Open interactive terminal UI. Use `/session_new` (or `/new`) inside the TUI to create a new agent session.

```bash
agent-bridge tui
```

#### `config [options]`

View or update global configuration.

```bash
agent-bridge config --show              # Show current configuration
agent-bridge config --token NEW_TOKEN   # Update bot token
agent-bridge config --server SERVER_ID  # Set Discord server ID manually
agent-bridge config --port 18470        # Set hook server port
```

### Project Commands

Run these commands from your project directory.

#### `init <agent> <description>`

Initialize current directory as a project.

```bash
agent-bridge init claude "Full-stack web application"
agent-bridge init opencode "Data pipeline project"
```

#### `start [options]`

Start the bridge server for registered projects.

```bash
agent-bridge start                        # Start all projects
agent-bridge start -p my-app             # Start a specific project
agent-bridge start -p my-app --attach    # Start and attach to tmux
```

#### `stop [project]`

Stop a project: kills tmux session, deletes Discord channel, and removes project state. Defaults to current directory name if project is not specified.

```bash
agent-bridge stop                # Stop current directory's project
agent-bridge stop my-app         # Stop a specific project
agent-bridge stop --keep-channel # Keep Discord channel (only kill tmux)
```

#### `status`

Show project status.

```bash
agent-bridge status
```

#### `attach [project]`

Attach to a project's tmux session. Defaults to current directory name if project is not specified.

```bash
agent-bridge attach              # Attach to current directory's project
agent-bridge attach my-app       # Attach to a specific project
```

Press `Ctrl-b d` to detach from tmux without stopping the agent.

#### `go [agent] [options]`

Quick start: start daemon, setup project if needed, and attach to tmux. Works without `init` — auto-detects installed agents and creates the Discord channel automatically.

```bash
agent-bridge go              # Auto-detect agent, setup & attach
agent-bridge go claude       # Use a specific agent
agent-bridge go --yolo       # YOLO mode (skip permissions, Claude Code only)
agent-bridge go --sandbox    # Sandbox mode (Docker isolation, Claude Code only)
agent-bridge go --no-attach  # Start without attaching to tmux
```

## How It Works

### Architecture

```
┌─────────────────┐
│  AI Agent CLI   │  (Claude, OpenCode)
│  Running in     │
│  tmux session   │
└────────┬────────┘
         │
         │ tmux capture-pane (every 30s)
         │
    ┌────▼─────────────┐
    │  CapturePoller   │  Detects state changes
    └────┬─────────────┘
         │
         │ Discord.js
         │
    ┌────▼──────────────┐
    │  Discord Channel  │  #project-name
    └───────────────────┘
```

### Components

- **Daemon Manager**: Single global process managing Discord connection
- **Capture Poller**: Polls tmux panes every 30s, detects changes, sends to Discord
- **Agent Registry**: Factory pattern for multi-agent support (Claude, OpenCode)
- **State Manager**: Tracks project state, sessions, and channels
- **Dependency Injection**: Interfaces for storage, execution, environment (testable, mockable)

### Polling Model

The bridge uses a **polling-based** architecture instead of hooks:

1. Every 30 seconds (configurable), the poller runs `tmux capture-pane`
2. Compares captured content with previous snapshot
3. If changes detected, sends new content to Discord
4. Handles multi-line output, ANSI codes, and rate limiting

This approach is simpler and more reliable than hook-based systems, with minimal performance impact.

### Project Lifecycle

1. **Go / Init**: Registers project in `~/.agent-messenger-bridge/state.json` and creates a Discord channel
2. **Start**: Launches AI agent in a named tmux session
3. **Polling**: Daemon captures tmux output and streams to Discord
4. **Stop**: Terminates tmux session, deletes channel, and cleans up state
5. **Attach**: User can join tmux session to interact directly

## Supported Agents

| Agent | Binary | Auto-Detect | YOLO Support | Sandbox Support | Notes |
|-------|--------|-------------|--------------|-----------------|-------|
| **Claude Code** | `claude` | Yes | Yes | Yes | Official Anthropic CLI |
| **Codex** | `codex` | Yes | No | No | OpenAI Codex CLI |
| **OpenCode** | `opencode` | Yes | No | No | Open-source alternative |

### Agent Detection

The CLI automatically detects installed agents using `command -v <binary>`. Run `agent-bridge agents` to see available agents on your system.

### Adding Custom Agents

To add a new agent, extend the `BaseAgentAdapter` class in `src/agents/`:

```typescript
export class MyAgentAdapter extends BaseAgentAdapter {
  constructor() {
    super({
      name: 'myagent',
      displayName: 'My Agent',
      command: 'myagent-cli',
      channelSuffix: 'myagent',
    });
  }

  getStartCommand(projectPath: string, yolo = false, sandbox = false): string {
    return `cd "${projectPath}" && ${this.config.command}`;
  }
}
```

Register your adapter in `src/agents/index.ts`.

## Configuration

### Global Config

Stored in `~/.agent-messenger-bridge/config.json`:

```json
{
  "token": "YOUR_BOT_TOKEN",
  "serverId": "YOUR_SERVER_ID",
  "hookServerPort": 18470
}
```

| Key | Required | Description | Default |
|-----|----------|-------------|---------|
| `token` | **Yes** | Discord bot token. Set via `agent-bridge setup <token>` or `config --token` | - |
| `serverId` | **Yes** | Discord server (guild) ID. Auto-detected by `setup`, or set via `config --server` | - |
| `hookServerPort` | No | Port for the hook server | `18470` |

```bash
agent-bridge config --show               # View current config
agent-bridge config --token NEW_TOKEN     # Update bot token
agent-bridge config --server SERVER_ID    # Set server ID manually
agent-bridge config --port 18470          # Set hook server port
```

### Project State

Project state is stored in `~/.agent-messenger-bridge/state.json` and managed automatically.

### Environment Variables

Config values can be overridden with environment variables:

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | **Yes** (if not in config.json) | Discord bot token | - |
| `DISCORD_GUILD_ID` | **Yes** (if not in config.json) | Discord server ID | - |
| `DISCORD_CHANNEL_ID` | No | Override default channel | Auto-created per project |
| `TMUX_SESSION_PREFIX` | No | Prefix for tmux session names | `agent-` |
| `TMUX_SESSION_MODE` | No | tmux session mode: `per-project` (default) or `shared` | `per-project` |
| `TMUX_SHARED_SESSION_NAME` | No | Shared tmux session name (without prefix), used when `TMUX_SESSION_MODE=shared` | `bridge` |
| `HOOK_SERVER_PORT` | No | Port for the hook server | `18470` |

```bash
DISCORD_BOT_TOKEN=token agent-bridge daemon start
DISCORD_GUILD_ID=server_id agent-bridge go
```

### tmux Session Mode (CLI)

You can also override tmux session behavior via CLI flags (no env vars needed):

```bash
agent-bridge go --tmux-session-mode shared --tmux-shared-session-name bridge
```

## Development

### Building

```bash
bun install
bun run build          # Compile TypeScript
bun run dev            # Dev mode
```

### Testing

```bash
bun test              # Run all tests
bun run test:watch    # Watch mode
bun run test:coverage # Coverage report
```

Test suite includes 129 tests covering:
- Agent adapters
- State management
- Discord client
- Capture polling
- CLI commands
- Storage and execution mocks

### Project Structure

```
agent-messenger-bridge/
├── bin/                  # CLI entry point (agent-bridge)
├── src/
│   ├── agents/           # Agent adapters (Claude, OpenCode)
│   ├── capture/          # tmux capture, polling, state detection
│   ├── config/           # Configuration management
│   ├── discord/          # Discord client and message handlers
│   ├── infra/            # Infrastructure (storage, shell, environment)
│   ├── state/            # Project state management
│   ├── tmux/             # tmux session management
│   └── types/            # TypeScript interfaces
├── tests/                # Vitest test suite
├── package.json
└── tsconfig.json
```

### Dependency Injection

The codebase uses constructor injection with interfaces for testability:

```typescript
// Interfaces
interface IStorage { readFile, writeFile, exists, unlink, mkdirp, chmod }
interface ICommandExecutor { exec, execVoid }
interface IEnvironment { get, homedir, platform }

// Usage
class DaemonManager {
  constructor(
    private storage: IStorage = new FileStorage(),
    private executor: ICommandExecutor = new ShellCommandExecutor()
  ) {}
}

// Testing
const mockStorage = new MockStorage();
const daemon = new DaemonManager(mockStorage);
```

### Code Quality

- TypeScript strict mode enabled
- ESM modules with `.js` extensions in imports
- Vitest with 129 passing tests
- No unused locals/parameters (enforced by `tsconfig.json`)

## Troubleshooting

### Bot not connecting

1. Verify token: `agent-bridge config --show`
2. Check bot permissions in Discord Developer Portal
3. Ensure MessageContent intent is enabled
4. Restart daemon: `agent-bridge daemon stop && agent-bridge daemon start`

### Agent not detected

1. Run `agent-bridge agents` to see available agents
2. Verify agent binary is in PATH: `which claude`
3. Install missing agent and retry

### tmux session issues

1. Check session exists: `tmux ls`
2. Kill stale session: `tmux kill-session -t <session-name>`
3. Restart project: `agent-bridge stop && agent-bridge start`

### No messages in Discord

1. Check daemon status: `agent-bridge daemon status`
2. Check daemon logs
3. Check Discord channel permissions (bot needs Send Messages)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Guidelines

- Add tests for new features
- Maintain TypeScript strict mode compliance
- Follow existing code style
- Update documentation as needed

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Discord.js](https://discord.js.org/)
- Powered by [Claude Code](https://code.claude.com/docs/en/overview) and [OpenCode](https://github.com/OpenCodeAI/opencode)
- Inspired by [OpenClaw](https://github.com/nicepkg/openclaw)'s messenger-based command system. The motivation was to remotely control and monitor long-running AI agent tasks from anywhere via Discord.

## Support

- Issues: [GitHub Issues](https://github.com/siisee11/agent-messenger-bridge/issues)
- Discord Bot Setup: [Setup Guide](docs/DISCORD_SETUP.md)
