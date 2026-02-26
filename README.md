# Mudcode

Bridge AI agent CLIs to Discord/Slack using tmux.

[한국어](README.ko.md)

## What Mudcode Does

- Runs your AI CLI in tmux (one window per project instance)
- Relays agent output to Discord/Slack via hook server
- Routes chat input back to the tmux pane
- Manages project/channel/session lifecycle from one CLI

Supported agent adapters:

- Claude Code
- Gemini CLI
- OpenCode
- OpenAI Codex CLI

## Requirements

- Bun `>=1.3`
- tmux `>=3.0`
- Discord bot token (or Slack bot/app tokens)
- At least one supported agent CLI installed locally

## Install

```bash
npm install -g @mudramo/mudcode
# or
bun add -g @mudramo/mudcode
```

Binary installer:

```bash
curl -fsSL https://mudcode.chat/install | bash
```

## Quick Start

```bash
mudcode onboard
cd ~/projects/my-app
mudcode new
```

Useful variants:

```bash
mudcode new claude
mudcode new codex --instance codex-2
mudcode attach my-app --instance codex-2
mudcode stop my-app --instance codex-2
```

## Core Commands

- `mudcode tui`: interactive terminal UI (default command)
- `mudcode onboard`: one-time onboarding
- `mudcode new [agent]`: create/resume project instance quickly
- `mudcode daemon <start|stop|status|restart>`: daemon lifecycle
- `mudcode list`: list projects/instances
- `mudcode status`: show config + tmux/project status
- `mudcode attach [project]`: attach to tmux session/window
- `mudcode stop [project]`: stop project or one instance
- `mudcode config --show`: inspect current config
- `mudcode agents`: list detected agent adapters
- `mudcode uninstall`: remove mudcode from machine

Run help for full options:

```bash
mudcode --help
mudcode new --help
mudcode config --help
```

## Bun Release Flow

From `mudcode/`:

```bash
npm run release:verify:bun
npm run release:publish:bun
```

Linux profile only:

```bash
npm run release:verify:bun:linux
npm run release:publish:bun:linux
```

Host-only (single target on current machine):

```bash
npm run release:verify:bun:single
npm run release:publish:bun:single
```

## Development

```bash
bun install
npm run typecheck
npm test
npm run test:e2e:tmux
npm run build
```

## Docs

- `docs/DISCORD_SETUP.md`
- `docs/SLACK_SETUP.md`
- `docs/RELEASE_NPM.ko.md`
- `ARCHITECTURE.md`
- `DEVELOPMENT.md`

## License

MIT
