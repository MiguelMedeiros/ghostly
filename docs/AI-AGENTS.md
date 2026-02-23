# AI Agents Integration

Give your AI agent encrypted superpowers! Ghostly integrates with [OpenClaw](https://openclaw.dev) and other AI coding agents.

## Install the Skill

### OpenClaw / Codex

```bash
curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.codex/skills/ghostly-cli/SKILL.md
```

### Cursor

```bash
curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.cursor/skills/ghostly-cli/SKILL.md
```

## Commands

| Command | Description |
|---------|-------------|
| `ghostly-cli send` | Send encrypted messages |
| `ghostly-cli recv` | Receive messages (poll once) |
| `ghostly-cli watch` | Stream incoming messages (NDJSON) |
| `ghostly-cli identity new` | Generate new keypair + shared key |
| `ghostly-cli invite new` | Create invite URL for peers |

## Bot Examples

### Echo Bot

```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Echo: $text 👻"
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

> 📖 Full documentation: [cli/SKILL.md](../cli/SKILL.md)
