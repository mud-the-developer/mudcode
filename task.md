# Changelog

## 2026-03-04 - Stabilization Cycle
- Updated Codex event-driven safety enforcement behavior.
- Hardened mapping self-heal and `/repair` mapping cache-clear flows.
- Improved visibility of progress suppression in `runtime-status` and `health`.
- Added regression tests for hook-server, message-router, capture-poller, and health.
- Added `/repair mapping` wiring regression coverage in `tests/index.test.ts` for the reload -> listProjects -> registerChannelMappings chain.
- Refactored Discord pending lifecycle to event-driven typing: typing now starts at `processing` transition, stops at terminal states, and no longer starts/retries from pending timers.
- Deferred Codex `markDispatching` state transitions to hook events when `eventHook` is enabled, aligning emoji/typing progression with `session.start/session.progress`.
- Added regression coverage for event-driven dispatching in `pending-message-tracker`, `hook-server`, and `message-router`.
- Hardened Discord reaction stability: `Unknown Message (10008)` targets are now suppression-cached with TTL, preventing repeated fetch/react/log storms on stale message IDs.
- Added capture stale auto-recovery: at stage-2 stale alerts, pending can be auto-marked `retry` once per stale baseline (event-driven safe fallback).
- Added orchestrator dead-worker reconciliation in capture poller: workers with missing tmux windows across repeated polls are pruned from state and supervisor worker registry.
- Expanded idle poll skipping to hidden orchestrator workers (not only codex primary), reducing unnecessary capture/tmux churn during no-pending windows.
- Tuned `health` noise model for ignored event-hook payloads: only recent/high-volume spikes warn; low/stale counts are now informational (`ok`).
- Added regression tests for Discord reaction suppression TTL, stale auto-recovery, dead-worker reconciliation, hidden-worker idle skip, and ignored-event health thresholds.
- Fixed state normalization edge-case: explicit empty `instances` no longer falls back to legacy maps (`agents/discordChannels/tmuxWindows`), preventing ghost worker resurrection during auto-prune flows.
- Added Discord output sanitization for `mudcode` control blocks (`[mudcode ...]...[/mudcode ...]`) so injected supervisor/longtask directives are stripped from channel-facing outputs by default.
- Updated health semantics for empty worker-only orchestrator projects: report informational `ok` ("workers cleaned") instead of operational warning.
- Optimized TypeScript parser hot paths: fast-path chunk split when no code fences, and single-pass file-path stripping via alternation regex (reduced per-path regex compile churn).
- Optimized Discord output formatter hot paths: hoisted reusable regexes, replaced split/map/join trailing-trim with multiline regex, and bypassed mudcode-block regex work when input has no `[mudcode`.
- Optimized Rust runtime parser (`mudcode-rs`) for acceleration mode: static lazy regex caching for extraction/cleanup and batched path stripping (3 regexes per call instead of 3×N per path).
- Added adaptive idle capture backoff in `BridgeCapturePoller`: idle windows now widen under sustained no-pending/no-activity periods (bounded by `AGENT_DISCORD_CAPTURE_IDLE_REFRESH_MAX_POLLS`), reducing tmux capture frequency while preserving fast wake-up on pending activity.
- Added raw-capture normalization cache in `BridgeCapturePoller`: when tmux raw capture is byte-identical to previous poll, parser normalization is skipped and cached cleaned snapshot is reused.
- Added parser single-line fast path in `splitRawText` to avoid repeated newline scans for long one-line outputs.
- Added Rust ASCII fast path for Discord chunk splitting in `mudcode-rs/src/parser.rs` to reduce character-boundary scan overhead on common ASCII payloads.
- Added regression test coverage for adaptive idle backoff behavior in `tests/bridge/runtime/capture-poller.test.ts`.
- Optimized `StateManager` save path: skipped disk writes when serialized state is unchanged (no-op set/remove updates no longer rewrite `state.json`).
- Added channel lookup cache in `StateManager` for O(1) `findProjectByChannel/getAgentTypeByChannel` resolution, with invalidation on reload/project mutations.
- Added `extractFilePaths` early-exit guards in TS/Rust parsers for texts without absolute path markers (`/`), avoiding unnecessary regex scans.
- Added `PendingMessageTracker.getPendingRouteSnapshot()` and switched capture poller to consume one pending snapshot per loop instead of repeated per-field pending lookups.
- Added regression coverage for pending route snapshot aggregation in `tests/bridge/runtime/pending-message-tracker.test.ts`.

## 2026-03-06 - Mapping Drop Recovery
- Fixed `BridgeCapturePoller` worker loop guard so instances without direct `instance.channelId` are still polled when pending-route channel/depth state exists.
- This restores capture-driven pending lifecycle recovery for hidden orchestrator workers (no longer permanently stuck on stale pending when hook lifecycle drops).
- Added regression coverage in `tests/bridge/runtime/capture-poller.test.ts` for pending-route output delivery with missing instance channel mapping.
- Extended `/repair` default flow to run mapping-recovery preflight (best-effort mapping reload, route-cache cleanup, turn-route cleanup, stale-pending cleanup) before doctor/restart.
- Extended `/repair mapping` to include stale pending cleanup and turn-route ledger cleanup in addition to channel mapping reload.
- Added `TurnRouteLedger.clearProject(projectName)` to support project-scoped route cleanup.
- Added regression coverage in `tests/bridge/runtime/message-router.test.ts` and `tests/bridge/runtime/turn-route-ledger.test.ts` for the new repair/mapping recovery behavior.
- Hardened `daemon restart --clear-session` safety: session clearing now targets only state-managed tmux sessions (no prefix-wide tmux scan), preventing accidental termination of unrelated sessions when `TMUX_SESSION_PREFIX` is empty.
- Added regression coverage in `tests/daemon-command.test.ts` for empty-prefix safety (no state-managed sessions => no tmux session kill).

## 2026-03-06 - oh-my-codex Pattern Import (Bridge Reliability)
- Added event payload normalization layer (`src/bridge/runtime/agent-event-payload.ts`) to accept snake_case and alias keys (`project_name`, `agent_type`, `event_type`, etc.) while preserving canonical hook-server behavior.
- Integrated normalized payload handling into `BridgeHookServer.handleAgentEvent`, reducing route/mapping drops caused by key-shape drift across hook emitters.
- Hardened progress flood control with duplicate-payload suppression window (`AGENT_DISCORD_EVENT_PROGRESS_DUPLICATE_WINDOW_MS`, default `10000ms`) in addition to existing per-turn burst caps.
- Expanded event text extraction fallback (`text/message/content/output/turnText`) to improve final output delivery resilience when upstream payload fields vary.
- Added `mudcode repair` filesystem lock with stale-lock recovery (`MUDCODE_REPAIR_LOCK_PATH`, `MUDCODE_REPAIR_LOCK_WAIT_MS`, `MUDCODE_REPAIR_LOCK_STALE_MS`) to prevent concurrent repair races.
- Switched storage writes to atomic temp-file rename in `FileStorage.writeFile`, reducing partial/corrupt state write risk during abrupt interruption.
- Added regression/unit coverage:
  - `tests/bridge/runtime/agent-event-payload.test.ts`
  - `tests/bridge/runtime/hook-server.test.ts` (snake_case event acceptance + duplicate progress suppression)
  - `tests/cli/commands/repair.test.ts` (busy lock rejection)

## 2026-03-06 - Event Pressure Control Batch 2
- Added per-turn progress char-budget suppression in `hook-server` (`AGENT_DISCORD_EVENT_PROGRESS_MAX_CHARS_PER_TURN`, default `6000`) to prevent long-running progress streams from flooding Discord.
- Extended runtime-status progress snapshot with `eventProgressEmittedChars` for turn-level pressure diagnostics.
- Added hook event outbox backpressure in `LocalAgentEventHookClient` (`AGENT_DISCORD_EVENT_HOOK_OUTBOX_MAX`, default `2000`) with oldest-progress-first drop policy.
- Added progress queue coalescing in `LocalAgentEventHookClient` so repeated `session.progress` events for the same turn collapse to the latest payload before dispatch.
- Added regression coverage:
  - `tests/bridge/runtime/hook-server.test.ts` (progress char-budget suppression)
  - `tests/bridge/events/agent-event-hook.test.ts` (outbox cap + progress coalescing)

## 2026-03-06 - Repair Restart Serialization
- Updated `/repair` runtime restart scheduling in `message-router` to invoke `mudcode repair restart-only` instead of direct `daemon restart`, ensuring the repair lock path is always applied for Discord-triggered repair flows.
- This prevents overlapping maintenance executions when `/repair` is triggered repeatedly in short intervals.
- Updated regression expectations in `tests/bridge/runtime/message-router.test.ts`.

## 2026-03-06 - oh-my-codex Pattern Import (Durable Dispatch + Replay)
- Added durable hook outbox persistence in `LocalAgentEventHookClient`:
  - persisted queue restore/replay on restart,
  - configurable path/flush/retention (`AGENT_DISCORD_EVENT_HOOK_OUTBOX_PATH`, `AGENT_DISCORD_EVENT_HOOK_OUTBOX_FLUSH_MS`, `AGENT_DISCORD_EVENT_HOOK_OUTBOX_RETENTION_MS`),
  - retained existing in-memory backpressure/coalescing behavior.
- Added Discord send idempotency cooldown in `DiscordClient` (`AGENT_DISCORD_OUTPUT_DEDUPE_WINDOW_MS`, default `2500ms`) to suppress short-window duplicate same-text bursts per queue/channel.
- Added missing-tmux-target deferred replay queue in `BridgeMessageRouter`:
  - when `can't find window/pane/session` occurs, prompt is queued for automatic retry instead of immediate hard-fail,
  - bounded retry/age/queue controls (`AGENT_DISCORD_TMUX_DEFER_MISSING_*` envs),
  - exponential backoff replay attempts with final fallback guidance on exhaustion.
- Added/updated regression coverage:
  - `tests/bridge/events/agent-event-hook.test.ts` (outbox persistence restore/replay),
  - `tests/discord/client.test.ts` (duplicate-output suppression window),
  - `tests/bridge/runtime/message-router.test.ts` (missing-target deferred retry path),
  - `tests/index.test.ts` expectation update for deferred-retry user notice.

## 2026-03-06 - Maintenance/Retry Noise Suppression
- Added background maintenance schedule cooldown in `BridgeMessageRouter` (`AGENT_DISCORD_BACKGROUND_CLI_SCHEDULE_COOLDOWN_MS`, default `15000ms`) to suppress duplicate `/repair restart-only`, `/repair verify`, `/update`, and `/daemon-restart` scheduling bursts.
- Updated maintenance command responses to emit duplicate-skip notice instead of re-scheduling identical background jobs during cooldown.
- Hardened missing-tmux deferred queue UX: when the same deferred key already exists, queue entry is refreshed but duplicate “queued for automatic retry” channel notice is suppressed.
- Added regression coverage:
  - `tests/bridge/runtime/message-router.test.ts` duplicate deferred queue notice suppression.
  - `tests/bridge/runtime/message-router.test.ts` duplicate `/daemon-restart` scheduling suppression.

## 2026-03-06 - Discord Output Flood Control (Chunk/Thread)
- Added Discord per-send chunk cap in `DiscordClient` (`AGENT_DISCORD_OUTPUT_MAX_CHUNKS`, default `4`): oversized split payloads now emit only capped chunks plus one truncation notice.
- Added long-output fan-out guard (`AGENT_DISCORD_LONG_OUTPUT_THREAD_MAX_CHUNKS`, default `8`): very large long-output payloads now skip thread pagination and send a condensed summary instead.
- Added long-output thread reuse per channel: repeated long outputs reuse existing thread when available instead of opening a new thread every time.
- Added regression coverage in `tests/discord/client.test.ts`:
  - chunk-cap truncation notice behavior,
  - condensed fallback path for very large long outputs,
  - long-output thread reuse behavior.

## 2026-03-06 - Input Idempotency + Upstream Fan-out Gate
- Added inbound dispatch idempotency in `BridgeMessageRouter`:
  - `messageId`-based duplicate suppression (`AGENT_DISCORD_INPUT_DEDUPE_MESSAGE_WINDOW_MS`),
  - signature-based short-window suppression for slash/control events without `messageId` (`AGENT_DISCORD_INPUT_DEDUPE_SIGNATURE_WINDOW_MS`),
  - bounded dedupe cache (`AGENT_DISCORD_INPUT_DEDUPE_MAX`).
- Hardened pending lifecycle against duplicate enqueue:
  - `PendingMessageTracker.markPending` now deduplicates same `messageId` per instance queue and refreshes metadata instead of pushing duplicates.
- Added upstream Discord chunk fan-out gate in both `BridgeHookServer` and `BridgeCapturePoller`:
  - capped split chunk sends with truncation notice using `AGENT_DISCORD_OUTPUT_MAX_CHUNKS`,
  - prevents hook/capture pre-split loops from bypassing downstream Discord client flood limits.
- Added regression coverage:
  - `tests/bridge/runtime/message-router.test.ts` duplicate inbound `messageId` skip,
  - `tests/bridge/runtime/message-router.test.ts` duplicate slash/control signature skip,
  - `tests/bridge/runtime/pending-message-tracker.test.ts` duplicate `markPending` handling,
  - `tests/bridge/runtime/hook-server.test.ts` terminal output chunk-cap behavior.

## 2026-03-07 - Discord Output Cleanup (Terminal In-flight + Repeated-line Compaction)
- Fixed a terminal sequencing corner case in `BridgeHookServer` where `session.final` could be dropped when its `seq` matched the latest progress `seq`; terminal events now allow equal-seq while still rejecting lower-seq stale events.
- Added same-turn terminal in-flight suppression (`BridgeHookServer`) so concurrent duplicate `session.final`/`session.idle` deliveries for the same turn no longer fan out multiple Discord outputs.
- Added deterministic repeated-line compaction in `formatDiscordOutput`:
  - removes consecutive duplicate lines,
  - limits global re-emission of long repeated lines,
  - appends omission marker when compaction occurred,
  - configurable via `AGENT_DISCORD_OUTPUT_DEDUPE_REPEATED_LINES` (default enabled).
- Added/updated regression coverage:
  - `tests/bridge/runtime/hook-server.test.ts` equal-seq terminal acceptance,
  - `tests/bridge/runtime/hook-server.test.ts` concurrent terminal in-flight suppression,
  - `tests/bridge/formatting/discord-output-formatter.test.ts` repeated-line compaction toggle/default behavior.

## 2026-03-07 - Overlap-safe Terminal Route Dedupe
- Hardened terminal dedupe scope in `BridgeHookServer` to collapse duplicate terminal events across overlapping instances when they target the same `channelId + turnId` route.
- Added route-level in-flight guard and completed-turn cache so repair/mapping overlap cannot fan out multiple `session.final` messages for one turn in the same Discord channel.
- Updated terminal signature dedupe key (turn-scoped) to ignore `instanceId`, reducing cross-instance duplicate leakage during overlap conditions.
- Added regression coverage:
  - `tests/bridge/runtime/hook-server.test.ts` overlapping-instance concurrent terminal suppression (`channel+turn` identical).

## 2026-03-07 - False ✅ Completion Guard (No-output Quiet + Empty Final)
- Fixed `BridgeCapturePoller` quiet-completion logic so codex event-driven mode no longer auto-completes pending turns before any visible output candidate appears, even if `capturePendingInitialQuietPollsCodex` is configured.
- Added `BridgeHookServer` empty-terminal fallback notice: when a terminal event has neither final text nor transcript fallback, the bridge now posts a short warning message instead of silently finishing with only ✅ reaction change.
- Added regression coverage:
  - `tests/bridge/runtime/capture-poller.test.ts` prevents no-output quiet auto-complete in event-hook mode.
  - `tests/bridge/runtime/hook-server.test.ts` verifies fallback notice on empty terminal payload.

## 2026-03-07 - False ✅ Completion Guard (Output-candidate Quiet Path)
- Reworked codex event-driven quiet handling in `BridgeCapturePoller`:
  - when output candidates exist, quiet-threshold now emits `session.final` via hook (`emitCodexFinal`) instead of calling `pendingTracker.markCompleted` directly,
  - when no output candidate exists, capture quiet windows remain observational and do not auto-complete.
- This prevents early `✅` reaction changes before terminal output is routed by `BridgeHookServer`.
- Kept codex input-ready auto-complete disabled in event-driven mode for non-final snapshots.
- Updated regression coverage:
  - `tests/bridge/runtime/capture-poller.test.ts` final hook emission path in event mode without capture-side `markCompleted`,
  - `tests/bridge/runtime/capture-poller.test.ts` no quiet auto-complete for no-output / output-candidate event-mode cases.

## 2026-03-07 - Discord Conclusion-only Output Compaction
- Added `Need/Changes/Verification` conclusion-only compaction in `formatDiscordOutput`:
  - when long final text includes those three sections, Discord output is auto-compacted to concise one-line summaries per section,
  - default enabled with opt-out env: `AGENT_DISCORD_OUTPUT_CONCLUSION_ONLY=false`.
- Kept behavior scoped to matching longtask-style responses only (non-matching outputs unchanged).
- Added regression coverage in `tests/bridge/formatting/discord-output-formatter.test.ts`:
  - default compaction on longtask-style final report,
  - opt-out behavior when env is disabled.

## 2026-03-08 - Event-driven Codex Final Reliability (Less Timer Dependence)
- Refined codex event-only final delivery in `BridgeCapturePoller`:
  - added turn-scoped source dedupe (`codexFinalHookTurnByInstance`) so capture path emits `session.final` at most once per turn,
  - wired immediate final emission to event signals (input-ready marker / pending-depth transition) via `flushBufferedOutput`, reducing quiet-timer dependency.
- Strengthened cleanup/turn-rotation handling:
  - clear final-emission turn guard on turn switch and capture-state cleanup,
  - clear guard when buffered output is exhausted or final path resets.
- Added regression coverage:
  - `tests/bridge/runtime/capture-poller.test.ts` verifies event mode emits `session.final` once per turn even when late deltas arrive after first final.

## 2026-03-08 - Repeat Final Flood Guard Hardening (3x Duplicate Case)
- Hardened event-only codex final emit path to prevent same-turn multi-final fan-out:
  - `flushBufferedOutput` now requires `turnId` for event-driven codex final emits (no-turn finals are skipped),
  - final-emission guard is no longer cleared immediately after successful emit, so late deltas in the same turn cannot re-emit final.
- Limited final-guard reset to explicit turn change and capture-state teardown.
- Re-validated capture/hook runtime regression suites and daemon health after restart.

## 2026-03-08 - Codex POC Progress Default-Off Gate (Intermediate Capture Suppression)
- Added a codex-poc safety gate in `BridgeHookServer`:
  - `session.progress` from `source=codex-poc` is now Discord-output suppressed by default (`mode=off`) even when per-event/global/policy mode requests thread/channel forwarding.
  - Progress transcript accumulation is preserved so `session.final` fallback-from-progress still works.
- Added opt-in escape hatch for debugging:
  - set `AGENT_DISCORD_CODEX_POC_PROGRESS_FORWARD=1` to re-enable codex-poc progress forwarding behavior.
- Updated and extended regression coverage:
  - `tests/bridge/runtime/hook-server.test.ts` adds a default-suppression regression for codex-poc progress with thread override request,
  - progress-forward tests now explicitly opt in with `AGENT_DISCORD_CODEX_POC_PROGRESS_FORWARD=1`,
  - runtime snapshot expectation updated to reflect default `eventProgressMode: off` for codex-poc progress path.
