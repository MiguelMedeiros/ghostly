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
        "install":
          [
            {
              "id": "cargo",
              "kind": "cargo",
              "crate": "ghostly-cli",
              "bins": ["ghostly-cli"],
              "label": "Install ghostly-cli (cargo)",
            },
          ],
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

```bash
cargo install ghostly-cli
```

## Quick Start

### Create Identity

```bash
ghostly-cli identity new > ~/.ghostly-identity.json
```

### Load Credentials

```bash
eval $(cat ~/.ghostly-identity.json | jq -r '@sh "SEED=\(.seed) PUBKEY=\(.pubkey) KEY=\(.shared_key)"')
```

### Generate Invite URL

```bash
ghostly-cli invite new --seed "$SEED"
```

Share the `invite_url` with users who want to chat.

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
{"messages":[{"text":"Hi","timestamp":1708123456789,"nick":"User"}],"message_count":1}
```

### Watch Messages (streaming)

```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY"
```

Output (NDJSON):
```json
{"from":"peer","text":"Hello bot!","timestamp":1708123456789,"nick":"User"}
```

### Read from Stdin

```bash
echo "Alert: Server down!" | ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" --stdin
```

### Parse Invite URL

```bash
ghostly-cli invite parse "ghost://pk:abc123...#key..."
```

## Flags

| Command | Flag | Description |
|---------|------|-------------|
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
| watch | `--poll-interval` | Poll interval in ms (default: 2000) |
| all | `--json` | Output JSON (default: true) |

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
  response=$(curl -s "https://api.openai.com/v1/chat/completions" \
    -H "Authorization: Bearer $OPENAI_KEY" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"'"$text"'"}]}' \
    | jq -r '.choices[0].message.content')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "$response"
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
- Check exit codes and parse error JSON from stderr
- Messages are encrypted but metadata (who talks to whom) may be observable
