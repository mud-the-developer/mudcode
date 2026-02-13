# Development Notes

## Switching Discode Runtime (Local vs Release)

`discode` normally runs the globally installed release package.

To make switching easy, add helper functions to `~/.zshrc`:

- `discode-rel`: force release runtime (ignores `DISCODE_BIN_PATH`)
- `discode-local`: run local compiled binary from this repo
- `discode-src`: run local TypeScript source directly

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
npm run build:release:binaries:single
```

The `discode-local` helper expects:

```text
/Users/dev/git/discode/dist/release/discode-darwin-arm64/bin/discode
```
