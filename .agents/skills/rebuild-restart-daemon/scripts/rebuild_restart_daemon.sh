#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Rebuild and restart mudcode daemon.

Usage:
  rebuild_restart_daemon.sh [--repo <path>] [--skip-build] [--dry-run]

Options:
  --repo <path>   Target repository path (default: current directory)
  --skip-build    Skip bun build and only restart daemon
  --dry-run       Print commands without executing them
  -h, --help      Show this help
EOF
}

repo_path="$(pwd)"
skip_build=0
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --repo" >&2
        exit 1
      fi
      repo_path="$2"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$repo_path" ]]; then
  echo "Repository path does not exist: $repo_path" >&2
  exit 1
fi

run_cmd() {
  echo "+ $*"
  if [[ "$dry_run" -eq 0 ]]; then
    "$@"
  fi
}

cd "$repo_path"

if [[ ! -f package.json ]]; then
  echo "package.json not found in $repo_path" >&2
  exit 1
fi

if [[ "$skip_build" -eq 0 ]]; then
  echo "[1/4] Build project"
  run_cmd bun run build
else
  echo "[1/4] Build skipped"
fi

echo "[2/4] Stop daemon"
run_cmd bun dist/bin/mudcode.js daemon stop

echo "[3/4] Start daemon"
run_cmd bun dist/bin/mudcode.js daemon start

echo "[4/4] Check daemon status"
run_cmd bun dist/bin/mudcode.js daemon status

echo "Done. Log: ~/.mudcode/daemon.log"
