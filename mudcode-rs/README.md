# mudcode-rs

Rust runtime for Mudcode hook delivery.

## Scope (Current)

- Handles hook events (including output relay paths)
- Sends messages/files to Discord channel mapped in state
- Exposes local HTTP endpoints for bridge integration

This crate is used as a runtime sidecar and is still migration-in-progress for full JS CLI parity.

## Run

```bash
cd mudcode-rs
cargo run
```

Default bind: `127.0.0.1:18470`

## Use From Mudcode CLI

```bash
export MUDCODE_DAEMON_RUNTIME=rust
mudcode daemon start
```

Runtime resolution order:

1. `MUDCODE_RS_BIN`
2. Local built binary under `mudcode-rs/target/...`
3. `cargo run` fallback

## Validate

```bash
cargo fmt
cargo check
cargo test
```
