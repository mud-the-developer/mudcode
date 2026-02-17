# Development Notes

## Switching Discode Runtime (Local vs Release)

By default, `discode` should point to your local TypeScript source runtime during development.

Add this patch to `~/.zshrc`:

```zsh
# --- Discode runtime switchers ---
export DISCODE_REPO="/Users/dev/git/discode"
export DISCODE_LOCAL_BIN="$DISCODE_REPO/dist/release/discode-darwin-arm64/bin/discode"

# Force globally installed release runtime
discode-rel() {
  env -u DISCODE_BIN_PATH command discode "$@"
}

# Force local compiled runtime
discode-local() {
  DISCODE_BIN_PATH="$DISCODE_LOCAL_BIN" command discode "$@"
}

# Run TypeScript source directly
discode-src() {
  bun run tsx "$DISCODE_REPO/bin/discode.ts" "$@"
}

# Default `discode` to local source runtime
alias discode='discode-src'
```

Helpers:

- `discode`: local TypeScript source runtime (default alias)
- `discode-local`: local compiled binary from this repo
- `discode-rel`: global installed release runtime (ignores `DISCODE_BIN_PATH`)
- `discode-src`: local TypeScript source runtime

Note: `discode-src` intentionally preserves your current working directory.
This keeps commands like `discode new` tied to the folder you ran them in.

After updating `~/.zshrc`, reload shell config:

```bash
source ~/.zshrc
```

### Commands

```bash
# Release (global installed package)
discode-rel onboard

# Local compiled binary
discode-local onboard

# Local source (tsx)
discode-src onboard
```

### Build local binary (when needed)

```bash
cd /Users/dev/git/discode
npm run build
npm run build:release:binaries:single
```

The `discode-local` helper expects:

```text
/Users/dev/git/discode/dist/release/discode-darwin-arm64/bin/discode
```

### Keep `discode-local` up to date

Use this workflow whenever `discode-local` behavior differs from `discode-src`, or after changing CLI code:

```bash
cd /Users/dev/git/discode
npm run build
npm run build:release:binaries:single
```

Quick verification:

```bash
# 1) Check the helper target path
echo "$DISCODE_LOCAL_BIN"

# 2) Confirm the binary is freshly updated
ls -l /Users/dev/git/discode/dist/release/discode-darwin-arm64/bin/discode

# 3) Smoke test onboarding behavior
discode-local onboard
```

If `discode-local` still behaves differently:

- Confirm your shell function is loaded from `~/.zshrc` (`type discode-local`).
- Confirm `DISCODE_LOCAL_BIN` points to the repo build output path above.
- Re-run `source ~/.zshrc` and test again.
