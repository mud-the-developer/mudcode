# Scripts Layout

Scripts are grouped by intent.

## `scripts/check/`

- `check-version-alignment.mjs`: validate version alignment across lockfiles.
- `check-todo-fixme.mjs`: fail on unresolved task-note keywords.
- `check-codex-event-contract.mjs`: local event-contract smoke check.

## `scripts/release/`

- `auto-bump-version.mjs`: bump patch version + optional dependency versions.
- `build-binaries.ts`: build platform packages.
- `build-npm-package.mjs`: build npm meta package.
- `rebuild-release-manifest.mjs`: regenerate release manifest.
- `pack-release.mjs`: `npm pack` artifacts.
- `publish-release.mjs`: publish release artifacts.

## `scripts/setup/`

- `setup-claude-plugin.ts`
- `setup-gemini-hook.ts`
- `setup-opencode-plugin.ts`

## `scripts/prompt/`

- `prompt-refiner-shadow-report.mjs`
- `prompt-refiner-shadow-to-gepa.mjs` (JS fallback)
- `prompt-refiner-codex-optimize.mjs` (Codex-only optimization runner; primary path)
- Rust primary path: `mudcode-rs/src/bin/prompt_refiner_shadow_to_gepa.rs`
- Rust/JS GEPA exporters both support `--dedupe-key baseline|baseline-candidate`, `--split-key sample|baseline`.
- `prompt-refiner-gepa-optimize.py` (GEPA optimization runner; supports `--smoke`, `--activate`)
- GEPA npm scripts use `uvx --from gepa==0.1.0` for reproducible invocation.

## `scripts/ci/`

- `ci-local.mjs`

## `package.json` Ops Scripts

- `ops:doctor`: run doctor report.
- `ops:doctor:fix`: run doctor with safe auto-fixes.
- `ops:daemon:restart`: restart daemon via CLI.
- `ops:self-heal`: build + `repair deep` (doctor fix + daemon restart + health verify).
- `ops:verify:fast`: quick regression set for config/capture/router/index hot paths.

## `scripts/migration/`

- `migrate-discode-cleanup.mjs`

## Root

- `postinstall.mjs`: npm postinstall helper kept at root for packaging compatibility.
