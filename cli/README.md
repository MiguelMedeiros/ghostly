# ghostly-cli (legacy)

A Rust compatibility client and library for bots and scripts: it sends and reads the v0.4 records
([WISP 402](../docs/wisps/402-legacy-chat.md)) over the Mainline DHT, with `ghost://` invites. Each side publishes a
small encrypted packet under its own key, and the other side reads it.

> **For a bot on today's Ghostly, use `ghostly`** ([docs/CLI.md](../docs/CLI.md), `packages/cli`): the app's own
> engine, with `ghostly1` invites, one chat, groups, files and payments. `ghostly-cli` cannot pair with the app: an
> app invite (`ghostly1…`) is refused with a message saying to open it in the Ghostly app. It stays, unchanged, for
> the bots already built on it.

- Agent skill and bot examples: [SKILL.md](SKILL.md).

```bash
cargo build --manifest-path cli/Cargo.toml     # target/debug/ghostly-cli
cargo test --manifest-path cli/Cargo.toml
```

## Install

The CLI is not on crates.io, so `cargo install ghostly-cli` does not work. Either:

- download the binary for your platform from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest): `ghostly-cli-macos-arm64`, `ghostly-cli-macos-x64`, `ghostly-cli-linux-x64` or `ghostly-cli-windows-x64.exe`, then `chmod +x` it and put it on your `PATH`;
- or build it from a clone:

  ```bash
  git clone https://github.com/MiguelMedeiros/ghostly.git
  cargo install --path ghostly/cli
  ```

## Quick start

```bash
# An identity: seed, public key and a shared key, as JSON
ghostly-cli identity new > ~/.ghostly-identity.json
chmod 600 ~/.ghostly-identity.json
eval "$(jq -r '@sh "SEED=\(.seed) PUBKEY=\(.pubkey) KEY=\(.shared_key)"' ~/.ghostly-identity.json)"

# An invite for the other side: ghost://<your public key>#<shared key>
ghostly-cli invite new --seed "$SEED" --key "$KEY"

# The other side reads it: your public key, the shared key, and a fresh seed of its own.
# It sends you its my_pubkey, which is your $PEER (the invite does not carry it).
ghostly-cli invite parse 'ghost://<public key>#<shared key>'

# Send, read once, or stream
ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Boo! 👻"
ghostly-cli recv --peer "$PEER" --key "$KEY"
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
```

## Commands

| Command | What it does | Prints |
|---|---|---|
| `identity new` | a new keypair and shared key | `{"seed","pubkey","shared_key"}` |
| `invite new --seed <SEED> [--key <KEY>]` | an invite URL; without `--key`, a new shared key | `{"invite_url","pubkey"}` |
| `invite parse <URL>` | reads a `ghost://` invite and makes a keypair for you | `{"peer_pubkey","shared_key","my_seed","my_pubkey"}` |
| `send --seed <SEED> --peer <PEER> --key <KEY> [--nick <NICK>] [--stdin] [MESSAGE]` | publishes one message | `{"ok","timestamp","messages_kept"}` |
| `recv --peer <PEER> --key <KEY>` | reads the peer's packet once | `{"messages":[{"text","timestamp","nick"}],"peer_ack","latest_ts","message_count"}` |
| `watch --seed <SEED> --peer <PEER> --key <KEY> [--nick <NICK>] [--poll-interval <MS>] [--ack]` | polls the peer (every 2000 ms by default) and prints each new message as one JSON line | `{"from":"peer","text","timestamp","nick"}` per line |

- Seeds and shared keys are base64url; public keys are z32. A value that starts with `-` is fine after its flag.
- `send` reads the message from the argument, or from stdin with `--stdin`. Put `--` before a message that starts with `-`.
- Timestamps are Unix time in milliseconds.
- `watch` acknowledges what it read by publishing an ack under your key. That is always on: `--ack` is accepted and changes nothing.
- A packet holds one short message: `send` replaces what you published before, and a message too long for the packet is cut to fit. The peer's `peer_ack` tells you it read yours.

## Global flags

| Flag | What |
|---|---|
| `--read-relays` | look packets up through the Pkarr relays too, not on the Mainline DHT alone: finds a new packet sooner, at the cost of the relays' per-address rate limits |
| `-q`, `--quiet` | `watch` does not print its polling errors |
| `--json` | accepted; the output is always JSON |
| `-h`, `--help` / `-V`, `--version` | help, version |

The CLI reads packets on the Mainline DHT directly. It publishes to the DHT and to the public Pkarr relays, because a contact in a browser reads only relays.

## Errors

A failure prints `{"error":"…"}` on stderr and exits with status 1. Check the exit code in scripts.

## Bots

Examples (an echo bot, a notification service, an agent tool): [SKILL.md](SKILL.md).
