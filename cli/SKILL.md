---
name: ghostly-cli
description: Send and receive encrypted ephemeral messages via the Ghost protocol using ghostly-cli. Use when user needs private, serverless messaging, building chat bots, sending encrypted notifications, or bridging messages to other platforms. Messages are E2E encrypted (NaCl) and transmitted via Mainline DHT (10M+ nodes).
homepage: https://ghostly.tools/cli
metadata:
  {
    "openclaw":
      {
        "emoji": "👻",
        "requires": { "bins": ["ghostly-cli"] },
      },
  }
---

# ghostly-cli

Use `ghostly-cli` to send/receive encrypted ephemeral messages via the Ghost protocol.

## When to Use

✅ **USE this skill when:**

- User wants to send encrypted messages to peers
- Building a chat bot that responds to messages
- Sending private notifications or alerts
- Bridging messages to/from other platforms
- Need serverless, decentralized messaging

❌ **DON'T use this skill for:**

- Persistent storage (messages are ephemeral)
- Large file transfers
- Real-time video/audio calls

## Install

`ghostly-cli` is not on crates.io. Download the binary for your platform from the
[latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest) (`ghostly-cli-macos-arm64`,
`ghostly-cli-macos-x64`, `ghostly-cli-linux-x64`, `ghostly-cli-windows-x64.exe`), `chmod +x` it and put it on your
`PATH`. Or build it from a clone:

```bash
git clone https://github.com/MiguelMedeiros/ghostly.git
cargo install --path ghostly/cli
```

## Quick Start

### Create Identity

```bash
ghostly-cli identity new > ~/.ghostly-identity.json
```

### Load Credentials

```bash
eval "$(jq -r '@sh "SEED=\(.seed) PUBKEY=\(.pubkey) KEY=\(.shared_key)"' ~/.ghostly-identity.json)"
```

### Generate Invite URL

```bash
ghostly-cli invite new --seed "$SEED" --key "$KEY"
```

Output: `{"invite_url":"ghost://<pubkey>#<shared key>","pubkey":"<pubkey>"}`. Without `--key` it makes a new
shared key.

Share the `invite_url`. The other side runs `invite parse` on it and sends you its `my_pubkey`: that is your
`$PEER` (the invite does not carry it).

## Commands

### Send Message

```bash
ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Hello!"
```

### Receive Messages (poll once)

```bash
ghostly-cli recv --peer "$PEER" --key "$KEY"
```

Output:
```json
{"messages":[{"text":"Hi","timestamp":1708123456789,"nick":"User"}],"peer_ack":1708123450000,"latest_ts":1708123456789,"message_count":1}
```

`peer_ack` is the newest of your messages the peer has read. Timestamps are Unix milliseconds.

### Watch Messages (streaming)

```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
```

Output (NDJSON), one line per new message:
```json
{"from":"peer","text":"Hello bot!","timestamp":1708123456789,"nick":"User"}
```

`watch` acknowledges what it read (always on). `--quiet` hides its polling errors.

### Read from Stdin

```bash
echo "Alert: Server down!" | ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" --stdin
```

### Parse Invite URL

```bash
ghostly-cli invite parse "ghost://<pubkey>#<shared key>"
```

Output: `{"peer_pubkey","shared_key","my_seed","my_pubkey"}`: the inviter's key, the shared key, and a new keypair
for you.

The CLI is a compatibility client: it reads only `ghost://` invites. An app invite (`ghostly1...`, or `https://ghostly.tools/#ghostly1...`) is refused with a message saying to open it in the Ghostly app.

## Flags

| Command | Flag | Description |
|---------|------|-------------|
| invite new | `--seed` | Your seed (base64url) |
| invite new | `--key` | Shared key (optional: a new one if absent) |
| send | `--seed` | Your seed (base64url) |
| send | `--peer` | Peer's pubkey (z32) |
| send | `--key` | Shared encryption key |
| send | `--nick` | Your nickname |
| send | `--stdin` | Read message from stdin |
| recv | `--peer` | Peer's pubkey (z32) |
| recv | `--key` | Shared encryption key |
| watch | `--seed` | Your seed (base64url) |
| watch | `--peer` | Peer's pubkey (z32) |
| watch | `--key` | Shared encryption key |
| watch | `--nick` | Your nickname |
| watch | `--poll-interval` | Poll interval in ms (default: 2000) |
| watch | `--ack` | Accepted; acks are always sent |
| all | `--read-relays` | Look packets up through the Pkarr relays too, not the Mainline DHT alone |
| all | `-q`, `--quiet` | `watch` does not print polling errors |
| all | `--json` | Accepted; output is always JSON |

A packet holds one short message: each `send` replaces your previous one, and a message too long for the packet is
cut to fit (`messages_kept`). If a message must arrive, wait until `peer_ack` reaches its `timestamp` before sending the
next one.

## Bot Patterns

### Echo Bot

```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Echo: $text"
done
```

### AI Bot (OpenAI)

```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  body=$(jq -n --arg text "$text" '{model: "gpt-4", messages: [{role: "user", content: $text}]}')
  response=$(curl -s "https://api.openai.com/v1/chat/completions" \
    -H "Authorization: Bearer $OPENAI_KEY" -H "Content-Type: application/json" \
    -d "$body" | jq -r '.choices[0].message.content')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" -- "$response"
done
```

### Notification Service

```bash
notify() {
  ghostly-cli send --seed "$BOT_SEED" --peer "$DEVICE_PUBKEY" --key "$KEY" \
    --nick "Server" "[$(date)] $1"
}

notify "Deployment completed"
notify "CPU usage above 90%"
```

## OpenClaw Integration

Add ghostly-cli as tools for your agent:

```yaml
tools:
  - name: ghost_send
    command: ghostly-cli send --seed $SEED --peer $PEER --key $KEY "$MESSAGE"
    
  - name: ghost_recv
    command: ghostly-cli recv --peer $PEER --key $KEY
```

## Security Notes

- Store credentials with restricted permissions (`chmod 600`)
- Use environment variables, never hardcode seeds
- Check exit codes: a failure prints `{"error":"..."}` on stderr and exits with 1
- Messages are encrypted but metadata (who talks to whom) may be observable
