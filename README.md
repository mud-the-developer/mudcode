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
# JS fallback:
# bun run prompt-refiner:export-gepa:js -- --val-ratio 0.2 --all
```

5. Run Codex-only optimization:

```bash
# Codex-only optimization
bun run prompt-refiner:codex -- --changed-only --fresh --iterations 4

# No-API smoke mode for local wiring checks
bun run prompt-refiner:codex:smoke

# One-shot pipeline (export + optimize)
bun run prompt-refiner:codex:pipeline
```

6. (Optional) Run GEPA optimization with automatic runtime policy activation:

```bash
# export + GEPA optimize + activate best policy into ~/.mudcode/prompt-refiner-active-policy.txt
bun run prompt-refiner:gepa:pipeline

# GEPA optimize only (manual activation disabled)
bun run prompt-refiner:gepa
```

Optional env vars:
- `MUDCODE_CODEX_OPT_MODEL` (optional `codex exec --model <name>` override)
- `MUDCODE_GEPA_ACTIVATE_MIN_IMPROVEMENT` (default `0.01`, GEPA auto-activation gate)

Notes:
- `prompt-refiner:codex` uses `codex exec` non-interactively, so Codex login/auth must be configured.
- `prompt-refiner:gepa:pipeline` updates `~/.mudcode/config.json` with `promptRefinerPolicyPath` automatically when activation succeeds.
- `prompt-refiner:gepa:pipeline` activates only when `valImprovement >= 0.01` by default.
- You can override policy path manually with `mudcode config --prompt-refiner-policy-path <path>`.

Modes:
- `off` (default): disabled
- `shadow`: logs refined candidate, sends original input
- `enforce`: sends refined candidate

Quick presets:
- `mudcode config --prompt-refiner-preset safe` (rollback preset: `mode=shadow`, policy path cleared)
- `mudcode config --prompt-refiner-preset enforce-policy` (`mode=enforce`, uses existing policy path or `~/.mudcode/prompt-refiner-active-policy.txt`)

Doctor safety check:
- `mudcode doctor` warns when `mode=enforce` but policy path is missing.
- `mudcode doctor --fix` auto-downgrades to `shadow` in that case.

## Discord Runtime Commands

Use these inside mapped channels/threads:

- `/retry`
- `/health`
- `/snapshot`
- `/io` (show Codex I/O tracker status + latest transcript path)
- `/orchestrator status|run|spawn|remove|enable|disable` (manual supervisor/worker orchestration controls; disabled by default)
  - run usage: `/orchestrator run <workerInstanceId> [--priority high|normal|low] <task>` (or `p2|p1|p0 <task>`)
  - spawn usage: `/orchestrator spawn [count]` (default `1`, max `8`)
  - remove usage: `/orchestrator remove <workerInstanceId>`
- `/subagents list|send|steer|spawn|info|log|kill` (OpenClaw-style alias for manual orchestrator controls; disabled by default)
  - send usage: `/subagents send <workerInstanceId> [--priority high|normal|low] <task>`
  - info usage: `/subagents info <workerInstanceId|#index>`
  - log usage: `/subagents log <workerInstanceId|#index> [tailLines]`
  - kill usage: `/subagents kill <workerInstanceId|all>`
- `/enter [count]`, `/tab [count]`, `/esc [count]`, `/up [count]`, `/down [count]`
- `/q` (close session + channel)
- `/qw` (archive channel + close session)

Orchestrator queue tuning:
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_DEPTH` (default `32`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_DRAIN_INTERVAL_MS` (default `1200`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_WAIT_TIMEOUT_MS` (default `600000`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_MAX_RETRIES` (default `2`)
- `AGENT_DISCORD_ORCHESTRATOR_QUEUE_RETRY_BACKOFF_MS` (default `1500`)
- `AGENT_DISCORD_ORCHESTRATOR_QOS_MAX_CONCURRENCY` (default `2`, hard cap for concurrently active workers)

Orchestrator automation:
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_ENABLE=1|0` (default `1`, auto-enable when multi-codex workers are available)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_VISIBILITY=hidden|thread|channel` (default `hidden`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MODE=off|continue|auto|always` (default `auto`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS=<n>` (default `1`, max workers for auto fanout dispatch)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN=1|0` (default `1`, auto-provision codex workers when auto-dispatch has no workers)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS=<n>` (default `2`, worker count to auto-provision; max `4`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER=1|0` (default `1`, split auto fanout into planner task assignments)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_PLANNER_PROMPT_MAX_CHARS=<n>` (default `1600`, truncate original request in planner payload)
- `AGENT_DISCORD_ORCHESTRATOR_CONTEXT_BUDGET_CHARS=<n>` (default `2600`, task-packet context budget gate)
- `AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_ITEMS=<n>` (default `6`, rolling summary item cap)
- `AGENT_DISCORD_ORCHESTRATOR_ROLLING_SUMMARY_MAX_CHARS=<n>` (default `900`, rolling summary char budget)
- `AGENT_DISCORD_ORCHESTRATOR_PACKET_INLINE_MAX_CHARS=<n>` (default `1800`, inline packet size limit before file externalization)
- `AGENT_DISCORD_ORCHESTRATOR_PACKET_ARTIFACT_ENABLED=1|0` (default `1`, write oversized task packets to `.mudcode/orchestrator/packets/*.md`)
- `AGENT_DISCORD_ORCHESTRATOR_MANUAL_COMMANDS=1|0` (default `0`, enable `/orchestrator` and `/subagents` manual runtime commands)

Self-check:
- `bun run orchestrator:auto:check` (auto enable/spawn/planner dispatch regression check)

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
- `AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE=continue|auto|always|off` to auto-append long-task execution/reporting policy hints (`continue` default)
- `AGENT_DISCORD_CODEX_EVENT_ONLY=1|0` (default `1`, set `0` to keep legacy direct capture output path)
- `AGENT_DISCORD_CODEX_EVENT_ONLY_CAPTURE_FALLBACK=0|1` (default `0`, set `1` to re-enable tmux stale fallback capture)
- `AGENT_DISCORD_EVENT_LIFECYCLE_STRICT_MODE=off|warn|reject` (default `warn`)
- `AGENT_DISCORD_SUPERVISOR_FINAL_FORMAT_STRICT=0|1` (default `1`, strict validator for supervisor final-format auto-retry policy)

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
