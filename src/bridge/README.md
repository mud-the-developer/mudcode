# Bridge Module Layout

This folder is organized by runtime responsibility to keep refactors local and predictable.

## Directories

- `runtime/`
  - Long-lived runtime components and request routing.
  - `capture-poller.ts`, `hook-server.ts`, `message-router.ts`, `pending-message-tracker.ts`
- `events/`
  - Event-contract transport and event-stream tracking.
  - `agent-event-hook.ts`, `codex-io-v2.ts`
- `formatting/`
  - Output formatting/sanitization helpers.
  - `discord-output-formatter.ts`
- `bootstrap/`
  - Startup/bootstrap integration for existing projects.
  - `project-bootstrap.ts`
- `skills/`
  - Skill discovery and prompt auto-linking helpers.
  - `skill-autolinker.ts`

## Dependency Direction

Keep imports one-way where possible:

- `runtime` may depend on `events`, `formatting`, `skills`.
- `events`, `formatting`, `skills`, `bootstrap` should avoid importing from `runtime`.
- Cross-cutting modules (`capture`, `state`, `messaging`, `policy`, `infra`) remain outside this folder.

This boundary keeps the hot-path runtime logic (`runtime/*`) testable without dragging unrelated setup code.
