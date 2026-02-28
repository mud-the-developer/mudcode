---
name: rebuild-restart-daemon
description: Rebuild and restart the Mudcode daemon for the mudcode project. Use when Codex must apply local code changes to the running daemon, recover from stale daemon state, or verify daemon health after config or environment updates.
---

# Rebuild Restart Daemon

## Overview

Rebuild the local project and restart its global daemon process with status verification. Prefer the bundled script for deterministic, repeatable execution.

## Workflow

1. Confirm the target directory is the `mudcode` repository.
2. Run the bundled script to rebuild and restart daemon.
3. Verify daemon status and report log path when failures occur.

## Execute Script

Run:

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/rebuild-restart-daemon/scripts/rebuild_restart_daemon.sh" --repo /path/to/mudcode
```

If the skill bundle is mirrored under `~/.codex/skills`, this path also works:

```bash
bash ~/.codex/skills/rebuild-restart-daemon/scripts/rebuild_restart_daemon.sh --repo /path/to/mudcode
```

Use options:

- `--repo <path>`: target repository path (default: current directory)
- `--skip-build`: skip `bun run build` and only restart daemon
- `--dry-run`: print commands without executing them

## Manual Fallback

Run:

```bash
cd /path/to/mudcode
bun run build
bun dist/bin/mudcode.js daemon stop
bun dist/bin/mudcode.js daemon start
bun dist/bin/mudcode.js daemon status
```

## Troubleshooting

- Inspect daemon log at `~/.mudcode/daemon.log`.
- Inspect daemon pid at `~/.mudcode/daemon.pid`.
- Re-run `bun dist/bin/mudcode.js daemon status` after resolving errors.
