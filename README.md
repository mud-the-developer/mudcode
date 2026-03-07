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
- `mudcode health [--project <name>] [--json]`: run diagnostics (optionally scoped to one project)
- `mudcode daemon <start|stop|status|restart>`: manage daemon
- `mudcode doctor [--fix]`: detect config/env/runtime drift and optionally auto-fix
- `mudcode repair [mode] [--project <name>]`: run self-heal flow (`default|doctor-only|restart-only|verify|deep`)
- `mudcode update [--git] [--explain]`: update to latest (auto git mode supported; `--explain` prints plan only)
- `mudcode stop [project] --instance <id>`: stop one instance
- `mudcode skill list [--all]`: list skills from `AGENTS.md` and `.agents/skills`
- `mudcode skill install [name]`: install local/no-api skills into Codex skills dir
- `mudcode config --show`: print current config
- `mudcode config --capture-final-buffer-max-chars <n>`: tune final-only buffer budget
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
# bun run prompt-refiner:export-gepa -- --val-ratio 0.2 --all --dedupe-key baseline-candidate --split-key baseline
# JS fallback:
# bun run prompt-refiner:export-gepa:js -- --val-ratio 0.2 --all --dedupe-key baseline-candidate --split-key baseline
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
- `MUDCODE_GEPA_DEDUPE_KEY` (optional dedupe strategy override: `baseline|baseline-candidate`)
- `MUDCODE_GEPA_SPLIT_KEY` (optional split strategy override: `sample|baseline`)

Notes:
- `prompt-refiner:codex` uses `codex exec` non-interactively, so Codex login/auth must be configured.
- `prompt-refiner:gepa*` scripts are pinned to `gepa==0.1.0` via `uvx` for reproducible runs.
- Exporter defaults stay backward-compatible: `--dedupe-key baseline` and `--split-key sample`.
- Pipelines now use `--dedupe-key baseline-candidate --split-key baseline` to retain changed variants while preventing baseline train/val leakage.
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

Quick list:
- plain non-slash text (default): forwarded to the mapped agent
- `/send <text>` (explicit submit path)
- `/orchestrator enable|disable [supervisorInstanceId|supervisor=<id>] [hidden|thread|channel]` (advanced/manual; shown in `/help all`)

- `/help [all]` (alias: `/commands [all]`; default = concise categories, `all` = include advanced orchestrator commands)
- `/retry`
- `/health`
- `/snapshot`
- `/io` (show Codex I/O tracker status + latest transcript path)
- `/repair [doctor-only|restart-only|verify|deep]` (default: run `doctor --fix` + schedule daemon restart; `verify/deep` auto-scope to current project)
- `/orchestrator status|run|spawn|remove|enable|disable` (manual supervisor/worker orchestration controls; disabled by default)
  - run usage: `/orchestrator run <workerInstanceId> [--priority high|normal|low] <task>` (or `p2|p1|p0 <task>`)
  - spawn usage: `/orchestrator spawn [count]` (default `1`, max `15`)
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
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_DISPATCH_MAX_WORKERS=<n>` (default `1`, max workers for auto fanout dispatch; max `15`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN=1|0` (default `1`, auto-provision codex workers when auto-dispatch has no workers)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_SPAWN_WORKERS=<n>` (default `2`, worker count to auto-provision; max `15`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_UNUSED_WORKERS=1|0` (default `1`, auto-remove idle dynamic workers)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_INTERVAL_MS=<n>` (default `60000`, cleanup scan interval; min `5000`)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_IDLE_MS=<n>` (default `300000`, idle age threshold before worker teardown)
- `AGENT_DISCORD_ORCHESTRATOR_AUTO_CLEANUP_MAX_REMOVALS=<n>` (default `2`, max workers removed per cleanup run; max `15`)
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
- `bun run ops:self-heal` (build + `repair deep` one-shot self-heal: doctor fix + restart + verify)
- `bun run ops:verify:fast` (quick regression set for config/capture/router/index)
- `bun run ops:verify:gepa` (GEPA/prompt-refiner regression set: typecheck + TS/Python/Rust checks + help smokes)

## Codex I/O v2

- Codex now starts with `--no-alt-screen` by default for better tmux scrollback visibility.
- Mudcode records Codex turn I/O transcript as JSONL: `~/.mudcode/io-v2/<project>/<instance>/YYYY-MM-DD.jsonl`
- If command markers are detected in output, Mudcode posts command start/end summaries in the mapped channel.
- Mudcode can auto-link skills from `AGENTS.md` (`### Available skills`) and append a skill hint to outgoing Codex prompts.

Environment toggles:
- Gemini preflight fallback:
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_ENABLED=1|0` (default `1`, check Gemini model capability before runtime dispatch)
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_MODEL=<model>` (default `pro 3.1`, target model string for preflight probe)
  - `AGENT_DISCORD_GEMINI_PREFLIGHT_CACHE_TTL_MS=<n>` (default `60000`, cache ttl for preflight probe result)
- Turn-route ledger:
  - `AGENT_DISCORD_TURN_ROUTE_RETENTION_MS=<n>` (default `21600000`, range `60000..86400000`; keep turn-to-channel route hints for event routing fallback)
  - `AGENT_DISCORD_TURN_ROUTE_MAX=<n>` (default `20000`, range `100..200000`; max in-memory turn route entries before oldest eviction)
- `AGENT_DISCORD_CODEX_IO_V2=0` to disable tracker
- `AGENT_DISCORD_CODEX_IO_V2_ANNOUNCE=0` to keep transcript logging but disable channel command event posts
- `AGENT_DISCORD_CODEX_IO_V2_DIR=/path` to change transcript root directory
- `MUDCODE_CODEX_AUTO_SKILL_LINK=0` to disable automatic skill-link hints
- `MUDCODE_STATE_LAST_ACTIVE_SAVE_DEBOUNCE_MS=<n>` (default `1500`, range `100..60000`; debounce interval for persisting `lastActive` updates)
- `AGENT_DISCORD_CODEX_AUTO_SUBAGENT_THREAD_CAP=<n>` (default `6`, cap hint injected to Codex for `spawn_agent`-style sub-agent concurrency)
- `AGENT_DISCORD_CODEX_AUTO_LONGTASK_REPORT_MODE=continue|auto|always|off` to auto-append long-task execution/reporting policy hints (`continue` default)
- `AGENT_DISCORD_CODEX_AUTO_LANGUAGE_POLICY_MODE=off|korean|always` (default `off`; set `korean`/`always` only when you explicitly want this extra policy hint)
- `AGENT_DISCORD_CAPTURE_FINAL_BUFFER_MAX_CHARS=<n>` (default `120000`, range `4000..500000`; final-only capture buffer budget before truncation)
- `AGENT_DISCORD_EVENT_PROGRESS_TRANSCRIPT_MAX_CHARS=<n>` (default `100000`, range `500..500000`; transcript budget used for empty `session.final` fallback)
- `AGENT_DISCORD_EVENT_PROGRESS_MAX_MESSAGES_PER_TURN=<n>` (default `6`, range `0..200`; per-turn progress burst guard, `0` disables suppression)
- `AGENT_DISCORD_EVENT_PROGRESS_MAX_CHARS_PER_TURN=<n>` (default `6000`, range `0..200000`; per-turn progress text budget, additional progress payloads are suppressed after this budget, `0` disables char-budget suppression)
- `AGENT_DISCORD_EVENT_PROGRESS_DUPLICATE_WINDOW_MS=<n>` (default `10000`, range `0..600000`; suppress repeated identical progress payloads within this window, `0` disables duplicate suppression)
- `AGENT_DISCORD_EVENT_PROGRESS_MODE_STALE_WARN_MS=<n>` (default `90000`, range `5000..3600000`; health warning threshold when pending Codex runtime progress-mode signal is stale)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX=<n>` (default `2000`, range `1..20000`; max in-memory queued hook events before backpressure drops oldest entries, preferring `session.progress`)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH=<path|off>` (default `~/.mudcode/runtime/agent-event-hook-outbox.json`; durable hook outbox path, set `off` to disable persistence)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS=<n>` (default `200`, range `0..10000`; outbox persistence flush cadence, `0` flushes synchronously)
- `AGENT_DISCORD_EVENT_HOOK_OUTBOX_RETENTION_MS=<n>` (default `86400000`, range `1000..604800000`; max age for restoring persisted hook outbox entries)
- `AGENT_DISCORD_OUTPUT_DEDUPE_WINDOW_MS=<n>` (default `2500`, range `0..60000`; suppress duplicate same-text output bursts per Discord queue within this window, `0` disables)
- `AGENT_DISCORD_OUTPUT_MAX_CHUNKS=<n>` (default `4`, range `1..40`; cap Discord text/page chunk fan-out per send, oversized payloads append one truncation notice chunk)
- `AGENT_DISCORD_LONG_OUTPUT_THREAD_MAX_CHUNKS=<n>` (default `8`, range `1..200`; if long-output estimated chunk count exceeds this, skip thread fan-out and send condensed summary instead)
- `AGENT_DISCORD_INPUT_DEDUPE_MESSAGE_WINDOW_MS=<n>` (default `1800000`, range `0..86400000`; inbound message-id idempotency window to skip duplicate dispatch)
- `AGENT_DISCORD_INPUT_DEDUPE_SIGNATURE_WINDOW_MS=<n>` (default `5000`, range `0..3600000`; short dedupe window for slash/control events without messageId)
- `AGENT_DISCORD_INPUT_DEDUPE_MAX=<n>` (default `50000`, range `100..1000000`; inbound dedupe cache max entries)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_ENABLED=1|0` (default `1`; when tmux target is missing, queue prompt for automatic replay instead of immediate hard-fail)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_BASE_MS=<n>` (default `2500`, range `250..60000`; base backoff for deferred tmux replay)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_MAX_MS=<n>` (default `15000`, range `500..120000`; max backoff for deferred tmux replay)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_RETRY_MAX_ATTEMPTS=<n>` (default `24`, range `1..200`; max attempts before deferred replay gives up)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_MAX_AGE_MS=<n>` (default `600000`, range `10000..86400000`; max queue age before deferred replay is dropped)
- `AGENT_DISCORD_TMUX_DEFER_MISSING_MAX_QUEUE=<n>` (default `400`, range `1..5000`; deferred replay queue cap)
- `AGENT_DISCORD_BACKGROUND_CLI_SCHEDULE_COOLDOWN_MS=<n>` (default `15000`, range `0..600000`; suppress duplicate background maintenance scheduling for same CLI args within cooldown, `0` disables)
- `MUDCODE_REPAIR_LOCK_PATH=<path>` (default `~/.mudcode/locks/repair.lock`; filesystem lock path used by `mudcode repair` to prevent concurrent runs)
- `MUDCODE_REPAIR_LOCK_WAIT_MS=<n>` (default `2000`, range `0..30000`; wait budget before failing when repair lock is busy)
- `MUDCODE_REPAIR_LOCK_STALE_MS=<n>` (default `300000`, range `1000..86400000`; stale lock age threshold before auto-recovery)
- `AGENT_DISCORD_CODEX_EVENT_POC=1|0` (default `1`; enable local Codex event-hook bridge, set `0` to force legacy direct-capture delivery)
- `AGENT_DISCORD_CODEX_EVENT_ONLY` is deprecated/ignored (no runtime effect; Codex safety gating remains enabled: `session.progress` channel -> thread/off and `session.idle` is suppressed by default)
- `AGENT_DISCORD_CODEX_EVENT_ONLY_IDLE_OUTPUT=1|0` (default `0`; debug/legacy override to re-enable Codex `session.idle` channel output while event-hook bridge is active)
- `AGENT_DISCORD_CODEX_FORCE_EVENT_OUTPUT=1|0` (default `1`; keep Codex output event-driven while event-hook bridge is enabled. `0` only disables the authoritative event-output gate and does not re-enable direct fallback while hook delivery is active)
- `AGENT_DISCORD_EVENT_HOOK_CAPTURE_OUTPUT=1|0` (default `0`; during event-hook stale-capture fallback, set `1` to allow legacy raw direct output for non-Codex instances)
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

## Attribution / Provenance

- Confirmed source repo (history evidence): README commit `795008e` (2026-02-11, `docs: add derived-from attribution in readme`) explicitly states this project is derived from [`DoBuDevel/discord-agent-bridge`](https://github.com/DoBuDevel/discord-agent-bridge). Commit `ada85e5` (2026-02-09) also points clone/support links to that repo.
- Imported/adapted baseline areas (history evidence): the first commit in this repository (`fd8b9da`, 2026-02-05) already contains the Discord bridge core at `src/discord/**`, `src/tmux/**`, `src/state/**`, `src/config/**`, `src/agents/**`, `src/index.ts`, and `src/daemon.ts`; these paths remain in this tree.
- Rewritten locally: later commits substantially reworked behavior and scope (renames to `agent-messenger-bridge` -> `discode` -> `mudcode`, Slack support, Codex runtime/orchestrator flows, and release packaging).
- License/credit note from local evidence: this repository is MIT-licensed (`LICENSE`, `package.json`). Local history includes explicit original-authorship attribution text; exact file-by-file import boundaries are not provable from local metadata alone.

## License

MIT
