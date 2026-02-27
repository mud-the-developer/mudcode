# Mudcode

Run AI agent CLIs in `tmux` and bridge them to Discord or Slack.

[한국어](README.ko.md)

## What It Does

- Runs one agent instance per `tmux` window
- Sends agent output to Discord/Slack
- Routes chat input back into the correct pane
- Manages project/instance lifecycle from one CLI

Supported adapters:

- Claude Code
- Gemini CLI
- OpenCode
- OpenAI Codex CLI

## Requirements

- Bun `>= 1.3`
- tmux `>= 3.0`
- Discord bot token (or Slack bot/app tokens)
- At least one supported agent CLI installed locally

## Install

Recommended (global install with Bun):

```bash
bun add -g @mudramo/mudcode
```

Alternative (npm):

```bash
npm install -g @mudramo/mudcode
```

Verify:

```bash
mudcode --version
```

## First-Time Setup

1. Configure platform tokens:

```bash
mudcode onboard
```

2. Move to your project and create an instance:

```bash
cd ~/projects/my-app
mudcode new codex
```

3. Attach when needed:

```bash
mudcode attach my-app --instance codex
```

## Core Commands

- `mudcode tui`: open interactive UI
- `mudcode new [agent]`: create/resume an instance quickly
- `mudcode list`: list projects and instances
- `mudcode status`: show config + runtime status
- `mudcode health [--json]`: run diagnostics
- `mudcode daemon <start|stop|status|restart>`: manage daemon
- `mudcode stop [project] --instance <id>`: stop one instance
- `mudcode config --show`: print current config
- `mudcode uninstall`: remove mudcode from machine

## Discord Runtime Commands

Use these inside mapped channels/threads:

- `/retry`
- `/health`
- `/snapshot`
- `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`
- `/q` (close session + channel)
- `/qw` (archive channel + close session)

## Upgrade / Remove

Upgrade:

```bash
bun add -g @mudramo/mudcode@latest
# or
npm install -g @mudramo/mudcode@latest
```

Remove:

```bash
mudcode uninstall
```

## Installation Troubleshooting

- `mudcode: command not found`: ensure Bun global bin is in PATH (`~/.bun/bin`) or reinstall globally.
- `tmux not found`: install tmux first (`brew install tmux` on macOS, `sudo apt install tmux` on Ubuntu).
- Platform binary missing: update to latest package; if still missing, run from source on that machine.

## Release Automation

Release is automated in GitHub Actions.

- Push to `main`: auto patch version bump + tag creation
- Tag push (`v*`): publish workflow runs with `full` profile (Linux/macOS/Windows targets)

Workflow files:

- `.github/workflows/auto-version-bump.yml`
- `.github/workflows/release-publish.yml`

## Docs

- `docs/DISCORD_SETUP.md`
- `docs/SLACK_SETUP.md`
- `docs/RELEASE_NPM.ko.md`
- `ARCHITECTURE.md`
- `DEVELOPMENT.md`

## License

MIT
