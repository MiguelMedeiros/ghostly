# CLI Documentation

For the terminal ghosts among us, there's `ghostly-cli`.

## Installation

```bash
cargo install ghostly-cli
```

Or download pre-built binaries from the [releases page](https://github.com/MiguelMedeiros/ghostly/releases).

## Quick Start

```bash
# Create your ghostly identity
ghostly-cli identity new > ~/.ghostly-identity.json

# Load credentials
eval $(cat ~/.ghostly-identity.json | jq -r '@sh "SEED=\(.seed) PUBKEY=\(.pubkey) KEY=\(.shared_key)"')

# Generate invite for your spooky friends
ghostly-cli invite new --seed "$SEED"

# Send a message
ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Boo! 👻"

# Watch for messages (streaming)
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `ghostly-cli identity new` | Generate new keypair + shared key |
| `ghostly-cli invite new` | Create invite URL for peers |
| `ghostly-cli send` | Send encrypted messages |
| `ghostly-cli recv` | Receive messages (poll once) |
| `ghostly-cli watch` | Stream incoming messages (NDJSON) |

## Environment Variables

You can set these environment variables instead of passing flags:

```bash
export GHOSTLY_SEED="your-seed-here"
export GHOSTLY_PEER="peer-pubkey-here"
export GHOSTLY_KEY="shared-key-here"
```

## Output Format

The `watch` command outputs NDJSON (newline-delimited JSON):

```json
{"timestamp":"2024-01-15T10:30:00Z","from":"peer-pubkey","text":"Hello!"}
{"timestamp":"2024-01-15T10:30:05Z","from":"peer-pubkey","text":"How are you?"}
```

> 📖 Full skill documentation: [cli/SKILL.md](../cli/SKILL.md)
