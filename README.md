<p align="center">
  <img src="hero-banner.png" alt="Ghostly - Encrypted Ephemeral Chat" width="100%">
</p>

<p align="center">
  <strong>Boo! Your chats float through 10M+ nodes and vanish without a trace.</strong><br>
  <em>No servers. No accounts. Just pure, spooky privacy.</em>
</p>

<p align="center">
  <a href="https://ghostly.chat">Website</a> •
  <a href="#-features">Features</a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-download">Download</a> •
  <a href="#-cli">CLI</a> •
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
  <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest/download/Ghostly.dmg">
    <img src="https://img.shields.io/badge/Download_for_macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS">
  </a>
  &nbsp;
  <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest/download/Ghostly.AppImage">
    <img src="https://img.shields.io/badge/Download_for_Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux">
  </a>
</p>

<p align="center">
  <a href="https://github.com/MiguelMedeiros/ghostly/releases">
    <img src="https://img.shields.io/github/v/release/MiguelMedeiros/ghostly?style=flat-square&label=Latest%20Release&color=22d3ee" alt="Latest Release">
  </a>
</p>

<p align="center">
  <sub>Or install the CLI: <code>cargo install ghostly-cli</code></sub>
</p>

---

## 👻 What is Ghostly?

**Ghostly** is a messenger from the spirit realm. Your messages are encrypted on your device, float through the DHT as ghostly whispers, and fade away when you close the app — leaving no trace behind, just like a proper ghost.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   👻 "Boo! Did you get my message?"                         │
│                                                             │
│                           💬 "Yep! Encrypted and all! 🔒"   │
│                                                             │
│   ✨ *messages vanish into the DHT void* ✨                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

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

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  1️⃣  CREATE CHAT                                                     │
│      Generate Ed25519 keypairs + 256-bit symmetric key               │
│      └─ No server involved!                                          │
│                                                                      │
│  2️⃣  SHARE INVITE                                                    │
│      URL contains: seed + peer pubkey + encryption key               │
│      └─ Fragment never leaves the app!                               │
│                                                                      │
│  3️⃣  MESSAGES TRAVEL                                                 │
│      plaintext → 🔒 encrypt → 📦 DNS TXT → ✍️ sign → 🌐 DHT          │
│      └─ XSalsa20-Poly1305 + Ed25519 + BEP44                          │
│                                                                      │
│  4️⃣  MESSAGES EXPIRE                                                 │
│      Stop republishing → TTL countdown (~5h) → 💨 gone forever       │
│      └─ No data persists. No trace remains.                          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### The Tech Stack of the Undead

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

### Build a Bot!

```bash
# Echo bot that haunts your messages
ghostly-cli watch --seed "$SEED" --peer "$PEER" --key "$KEY" | while read -r msg; do
  text=$(echo "$msg" | jq -r '.text')
  ghostly-cli send --seed "$SEED" --peer "$PEER" --key "$KEY" "Echo: $text 👻"
done
```

## 📜 License

MIT License - feel free to haunt this code anywhere!

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
  <a href="https://ghostly.chat">🌐 Website</a> •
  <a href="https://github.com/MiguelMedeiros/ghostly/issues">🐛 Issues</a> •
  <a href="https://github.com/MiguelMedeiros/ghostly/releases">📦 Releases</a>
</p>
