# Development Notes

## Switching Mudcode Runtime (Local vs Release)

By default, `mudcode` should point to your local TypeScript source runtime during development.

Add this patch to `~/.zshrc`:

```zsh
# --- Mudcode runtime switchers ---
export MUDCODE_REPO="/Users/dev/git/mudcode"
export MUDCODE_LOCAL_BIN="$MUDCODE_REPO/dist/release/mudcode-darwin-arm64/bin/mudcode"

# Force globally installed release runtime
mudcode-rel() {
  env -u MUDCODE_BIN_PATH command mudcode "$@"
}

# Force local compiled runtime
mudcode-local() {
  MUDCODE_BIN_PATH="$MUDCODE_LOCAL_BIN" command mudcode "$@"
}

# Run TypeScript source directly
mudcode-src() {
  bun run tsx "$MUDCODE_REPO/bin/mudcode.ts" "$@"
}

# Default `mudcode` to local source runtime
alias mudcode='mudcode-src'
```

Helpers:

- `mudcode`: local TypeScript source runtime (default alias)
- `mudcode-local`: local compiled binary from this repo
- `mudcode-rel`: global installed release runtime (ignores `MUDCODE_BIN_PATH`)
- `mudcode-src`: local TypeScript source runtime

Note: `mudcode-src` intentionally preserves your current working directory.
This keeps commands like `mudcode new` tied to the folder you ran them in.

After updating `~/.zshrc`, reload shell config:

```bash
source ~/.zshrc
```

### Commands

```bash
# Release (global installed package)
mudcode-rel onboard

# Local compiled binary
mudcode-local onboard

# Local source (tsx)
mudcode-src onboard
```

### Build local binary (when needed)

```bash
cd /Users/dev/git/mudcode
npm run build
npm run build:release:binaries:single
```

The `mudcode-local` helper expects:

```text
/Users/dev/git/mudcode/dist/release/mudcode-darwin-arm64/bin/mudcode
```

### Keep `mudcode-local` up to date

Use this workflow whenever `mudcode-local` behavior differs from `mudcode-src`, or after changing CLI code:

```bash
cd /Users/dev/git/mudcode
npm run build
npm run build:release:binaries:single
```

Quick verification:

```bash
# 1) Check the helper target path
echo "$MUDCODE_LOCAL_BIN"

# 2) Confirm the binary is freshly updated
ls -l /Users/dev/git/mudcode/dist/release/mudcode-darwin-arm64/bin/mudcode

# 3) Smoke test onboarding behavior
mudcode-local onboard
```

If `mudcode-local` still behaves differently:

- Confirm your shell function is loaded from `~/.zshrc` (`type mudcode-local`).
- Confirm `MUDCODE_LOCAL_BIN` points to the repo build output path above.
- Re-run `source ~/.zshrc` and test again.
