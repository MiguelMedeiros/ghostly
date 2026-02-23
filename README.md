<p align="center">
  <img src="hero-banner.png" alt="Ghostly - Encrypted Ephemeral Chat" width="100%">
</p>

<p align="center">
  <strong>Boo! Your chats float through 10M+ nodes and vanish without a trace.</strong><br>
  <em>No servers. No accounts. Just pure, spooky privacy.</em>
</p>

<p align="center">
  <a href="https://ghostly.tools">Website</a> •
  <a href="#-features">Features</a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-download">Download</a> •
  <a href="#-cli">CLI</a> •
  <a href="#-ai-agents--openclaw">AI Agents</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/rust-%23000000.svg?style=for-the-badge&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/react-%2320232a.svg?style=for-the-badge&logo=react&logoColor=%2361DAFB" alt="React">
  <img src="https://img.shields.io/badge/tauri-%2324C8DB.svg?style=for-the-badge&logo=tauri&logoColor=%23FFFFFF" alt="Tauri">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="MIT License">
</p>

---

## 👻 Download

<p align="center">
  <strong>Become a ghost in seconds. No sign-up. No traces.</strong>
</p>

<p align="center">
  <a href="https://github.com/MiguelMedeiros/ghostly/releases">
    <img src="https://img.shields.io/github/v/release/MiguelMedeiros/ghostly?style=flat-square&label=Latest%20Release&color=22d3ee" alt="Latest Release">
  </a>
</p>

### Desktop Apps

| Platform | Architecture | Download |
|----------|--------------|----------|
| **macOS** | Apple Silicon (M1/M2/M3) | [Ghostly_aarch64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_aarch64.dmg) |
| **macOS** | Intel (x64) | [Ghostly_x64.dmg](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_x64.dmg) |
| **Windows** | x64 (Installer) | [Ghostly_x64-setup.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_x64-setup.exe) |
| **Windows** | x64 (MSI) | [Ghostly_x64.msi](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_x64_en-US.msi) |
| **Linux** | x64 (AppImage) | [Ghostly_amd64.AppImage](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_amd64.AppImage) |
| **Linux** | x64 (Debian/Ubuntu) | [Ghostly_amd64.deb](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/Ghostly_0.0.1_amd64.deb) |

### CLI (Command Line)

| Platform | Download |
|----------|----------|
| **macOS** (Apple Silicon) | [ghostly-cli-macos-arm64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/ghostly-cli-macos-arm64) |
| **macOS** (Intel) | [ghostly-cli-macos-x64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/ghostly-cli-macos-x64) |
| **Linux** (x64) | [ghostly-cli-linux-x64](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/ghostly-cli-linux-x64) |
| **Windows** (x64) | [ghostly-cli-windows-x64.exe](https://github.com/MiguelMedeiros/ghostly/releases/download/v0.1.0/ghostly-cli-windows-x64.exe) |

Or install via Cargo:

```bash
cargo install ghostly-cli
```

---

## 👻 What is Ghostly?

**Ghostly** is a messenger from the spirit realm. Your messages are encrypted on your device, float through the DHT as ghostly whispers, and fade away when you close the app — leaving no trace behind, just like a proper ghost.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔐 **E2E Encrypted** | 256-bit NaCl secretbox encryption. Even other ghosts can't read your messages. |
| 👻 **Ephemeral** | Messages vanish from the DHT in ~5 hours. No persistence, no traces. |
| 🌐 **Serverless** | No servers to possess, no infrastructure to haunt. Your ghost roams free. |
| 📹 **Video Calls** | Face-to-face ghostly encounters with WebRTC. |
| 📞 **Voice Calls** | Crystal clear spectral communication. |
| 🎨 **Emojis & GIFs** | Express yourself with the full range of haunted reactions. |
| 💻 **Open Source** | Trust, but verify. All code is open for exorcism... I mean, audit. |

## 🔮 How It Works

Ghostly uses a clever combination of cryptography and the decentralized web:

| Step | What Happens |
|------|--------------|
| **1. Create Chat** | Generate Ed25519 keypairs + 256-bit symmetric key. No server involved! |
| **2. Share Invite** | URL contains seed + peer pubkey + encryption key. Fragment never leaves the app! |
| **3. Messages Travel** | Plaintext → Encrypt → DNS TXT → Sign → DHT (XSalsa20-Poly1305 + Ed25519 + BEP44) |
| **4. Messages Expire** | Stop republishing → TTL countdown (~5h) → Gone forever. No trace remains. |

### Tech Stack

- **[Pkarr](https://github.com/pubky/pkarr)** - Public Key Addressable Resource Records
- **[Mainline DHT](https://en.wikipedia.org/wiki/Mainline_DHT)** - 10M+ nodes, largest P2P network on Earth
- **NaCl Secretbox** - XSalsa20-Poly1305 authenticated encryption
- **Ed25519** - Digital signatures for message authenticity
- **BEP44** - BitTorrent DHT mutable items specification

## 🔧 Build from Source

Prefer to summon your own ghost? Here's how:

```bash
# Clone the haunted repository
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly

# Install dependencies
npm install

# Summon the ghost (development)
npm run tauri dev

# Build for production
npm run tauri build
```

### Requirements

- Node.js 18+
- Rust 1.70+
- [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

> 💡 **Tip:** The built app will be in `src-tauri/target/release/bundle/`

## 🖥️ CLI

For the terminal ghosts among us, there's `ghostly-cli`:

```bash
# Install via cargo
cargo install ghostly-cli

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

## 🤖 AI Agents & OpenClaw

Give your AI agent encrypted superpowers! Ghostly integrates with [OpenClaw](https://openclaw.dev) and other AI coding agents.

### Install the Skill

```bash
# OpenClaw / Codex
curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.codex/skills/ghostly-cli/SKILL.md

# Cursor
curl -fsSL https://raw.githubusercontent.com/MiguelMedeiros/ghostly/main/cli/SKILL.md \
  -o ~/.cursor/skills/ghostly-cli/SKILL.md
```

### What Your Agent Can Do

| Command | Description |
|---------|-------------|
| `ghostly-cli send` | Send encrypted messages |
| `ghostly-cli recv` | Receive messages (poll once) |
| `ghostly-cli watch` | Stream incoming messages (NDJSON) |
| `ghostly-cli identity new` | Generate new keypair + shared key |
| `ghostly-cli invite new` | Create invite URL for peers |

### Bot Examples

**Echo Bot**
```bash
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Echo: $text 👻"
done
```

**AI Bot (OpenAI)**
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

**Notification Service**
```bash
notify() {
  ghostly-cli send --seed "$BOT_SEED" --peer "$DEVICE_PUBKEY" --key "$KEY" \
    --nick "Server" "[$(date)] $1"
}

notify "Deployment completed"
notify "CPU usage above 90%"
```

> 📖 Full documentation: [cli/SKILL.md](cli/SKILL.md)

## 🤝 Contributing

Want to help? Check out our [Contributing Guide](CONTRIBUTING.md)!

---

<p align="center">
  <strong>Built with 👻 by <a href="https://github.com/miguelmedeiros">@miguelmedeiros</a></strong>
</p>

<p align="center">
  <em>"The end. Now go haunt someone!"</em>
</p>

<p align="center">
  <a href="https://ghostly.tools">🌐 Website</a> •
  <a href="https://github.com/MiguelMedeiros/ghostly/issues">🐛 Issues</a> •
  <a href="https://github.com/MiguelMedeiros/ghostly/releases">📦 Releases</a>
</p>
