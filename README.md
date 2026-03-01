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
- `mudcode skill list [--all]`: list skills from `AGENTS.md` and `.agents/skills`
- `mudcode skill install [name]`: install local/no-api skills into Codex skills dir
- `mudcode config --show`: print current config
- `mudcode uninstall`: remove mudcode from machine

## Prompt Refiner (Shadow Mode)

Use this to evaluate prompt cleanup safely before enforcing it.

1. Enable shadow mode:

```bash
mudcode config --prompt-refiner-mode shadow
```

2. (Optional) set custom log path:

```bash
mudcode config --prompt-refiner-log-path ~/.mudcode/prompt-refiner-shadow.jsonl
```

3. Generate a quick report:

```bash
bun run prompt-refiner:report
```

4. Export a GEPA-ready train/val dataset:

```bash
bun run prompt-refiner:export-gepa
# optional:
# bun run prompt-refiner:export-gepa -- --val-ratio 0.2 --all
```

Modes:
- `off` (default): disabled
- `shadow`: logs refined candidate, sends original input
- `enforce`: sends refined candidate

## Discord Runtime Commands

Use these inside mapped channels/threads:

- `/retry`
- `/health`
- `/snapshot`
- `/io` (show Codex I/O tracker status + latest transcript path)
- `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`
- `/q` (close session + channel)
- `/qw` (archive channel + close session)

## Codex I/O v2

- Codex now starts with `--no-alt-screen` by default for better tmux scrollback visibility.
- Mudcode records Codex turn I/O transcript as JSONL: `~/.mudcode/io-v2/<project>/<instance>/YYYY-MM-DD.jsonl`
- If command markers are detected in output, Mudcode posts command start/end summaries in the mapped channel.
- Mudcode can auto-link skills from `AGENTS.md` (`### Available skills`) and append a skill hint to outgoing Codex prompts.

Environment toggles:
- `AGENT_DISCORD_CODEX_IO_V2=0` to disable tracker
- `AGENT_DISCORD_CODEX_IO_V2_ANNOUNCE=0` to keep transcript logging but disable channel command event posts
- `AGENT_DISCORD_CODEX_IO_V2_DIR=/path` to change transcript root directory
- `MUDCODE_CODEX_AUTO_SKILL_LINK=0` to disable automatic skill-link hints

## Upgrade / Remove

Upgrade:

```bash
bun add -g @mudramo/mudcode@latest
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

- `docs/setup/DISCORD_SETUP.md`
- `docs/setup/SLACK_SETUP.md`
- `docs/release/RELEASE_NPM.ko.md`
- `ARCHITECTURE.md`
- `DEVELOPMENT.md`

## License

MIT
