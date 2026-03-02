# Optimization / Feature Backlog (v2)

This is a practical follow-up list after current stabilization work.

## P0 (Operational safety)

1. `mudcode repair --deep`
- Include `doctor --fix`, daemon restart, and a lightweight runtime probe (`health --capture-test`) in one command.
- Emit one compact summary for Discord runtime usage.

2. Runtime policy drift auto-heal
- If orchestrator worker visibility is `hidden` but progress mode is not `off`, auto-correct project policy and log one warning.

3. Hook/capture failover telemetry
- Add counters for event-only fallback usage and stale lifecycle recoveries.
- Expose counters in `/runtime-status` and `mudcode doctor`.

## P1 (Performance / scale)

1. Adaptive capture polling
- Dynamically widen poll interval when instance is idle and shrink on activity.
- Goal: lower tmux capture overhead with no UX regression.

2. Orchestrator queue persistence
- Persist in-flight queued tasks for supervisor restart recovery.
- Recover queue safely on daemon restart with stale-task TTL.

3. Rate-limited summary batching
- Batch noisy progress updates into bounded windows per instance.
- Improve channel readability and reduce message flood.

## P2 (UX)

1. Config profile presets
- Named presets for `strict-event-only`, `high-throughput`, `low-noise`.
- One-shot switch via `mudcode config --preset <name>`.

2. Runtime quick actions
- Add `/repair` variants:
  - `/repair doctor-only`
  - `/repair restart-only`
  - `/repair verify`

3. Install mode visibility
- `mudcode update --explain` to print exact mode (git/registry), install path, and dedupe outcome before running.
