# Module Boundaries

This document defines the architectural boundaries introduced during refactor stage 6.

## Dependency Direction

Use this one-way dependency flow:

`bin/discode.ts` -> `src/cli/**` -> `src/app/**` -> `src/{bridge,state,tmux,discord,agents,infra}`

Rules:

- `src/cli/**` handles argument parsing, prompts, and user-facing output.
- `src/app/**` owns use-case orchestration shared by multiple CLI commands.
- `src/bridge/**` owns daemon runtime concerns (message routing, hook server, bootstrap, pending reactions).
- `src/policy/**` contains reusable rules shared across CLI/app/bridge (naming, launch command shaping, integration policy).
- `src/infra/**` provides low-level utilities only (shell escaping, storage, environment access).

## Policy Modules

- `src/policy/window-naming.ts`
  - `toSharedWindowName`
  - `toProjectScopedName`
  - `resolveProjectWindowName`
- `src/policy/agent-launch.ts`
  - `buildExportPrefix`
  - `buildAgentLaunchEnv`
  - `withClaudePluginDir`
- `src/policy/agent-integration.ts`
  - `installAgentIntegration`

These modules are the single source of truth for shared behavior.

## Change Guidelines

When adding or changing behavior:

1. If logic is shared by CLI and bridge, move it to `src/policy/**`.
2. Keep side effects (tmux, Discord, fs, process) in app/bridge/infra layers, not policy functions.
3. Add/extend focused tests first in `tests/policy/**` or `tests/*` for touched flows.
4. Keep dependency direction acyclic; avoid importing `src/cli/**` from any non-CLI module.

## Validation Checklist

Before merge:

- `npm test` passes.
- `npm run typecheck` has no new errors outside known pre-existing issues.
- Core flows (`new`, `attach`, `stop`, bridge start/stop/event path) remain stable.
