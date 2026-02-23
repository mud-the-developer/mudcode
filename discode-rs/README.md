# discode-rs

Rust migration starter for `discode` focused on Discord output delivery.

## What is implemented

- `POST /opencode-event`
  - Handles `session.idle` and `session.error`
  - Resolves target Discord channel from `~/.discode/state.json`
  - Sends output to Discord using Bot API
  - Splits long messages with Discord 2000-char limit logic inspired by `zeroclaw/src/channels/discord.rs`
  - Extracts absolute file paths from output, strips them from text, and uploads files separately

- `POST /send-files`
  - Validates files are inside project path
  - Uploads files to the mapped Discord channel

- `POST /reload`
  - Returns `200 OK` (placeholder for future hot-reload hooks)

Current scope: hook/event relay only. Discord inbound command routing and full CLI parity are not migrated yet.

## Config and state

- Config path: `~/.discode/config.json` (or `DISCODE_CONFIG_PATH`)
- State path: `~/.discode/state.json` (or `DISCODE_STATE_PATH`)
- Token source priority:
  1. `config.json` `token`
  2. `DISCORD_BOT_TOKEN`

Supported env vars:

- `DISCORD_BOT_TOKEN`
- `HOOK_SERVER_PORT`
- `DISCODE_CONFIG_PATH`
- `DISCODE_STATE_PATH`

## Run

```bash
cd discode-rs
cargo run
```

Default bind address: `127.0.0.1:18470`

## Run Through Existing CLI (Experimental)

You can make `discode` daemon start this Rust runtime:

```bash
export DISCODE_DAEMON_RUNTIME=rust
discode daemon start
```

Runtime resolution order:

1. `DISCODE_RS_BIN` (explicit binary path)
2. local `discode-rs/target/{release,debug}/discode-rs`
3. `cargo run --manifest-path ...` (uses `DISCODE_RS_MANIFEST` or local `discode-rs/Cargo.toml`)

## Verify

```bash
cargo fmt
cargo test
cargo check
```

## Next migration targets

- Discord inbound message listening (Gateway)
- Channel creation/mapping sync
- Tmux + project bootstrap pipeline
- Full CLI replacement (`bin/discode.ts` parity)
