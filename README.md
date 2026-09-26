<p align="center">
  <img src="docs/assets/ghostly-app.webp" alt="Ghostly: a chat with a contact, the wallet deck with its Mainnet and Testnet tabs, and the identity cards" width="100%">
</p>

<p align="center">
  <strong>Boo! Find each other through the DHT. Talk peer to peer.</strong><br>
  <em>No Ghostly server. No account. Your keys, your history, your money.</em>
</p>

<p align="center">
  <a href="https://ghostly.tools">Website</a> •
  <a href="https://app.ghostly.tools">Web app</a> •
  <a href="#get-ghostly">Download</a> •
  <a href="#documentation">Docs</a> •
  <a href="docs/wisps/README.md">WISPs</a> •
  <a href="CONTRIBUTING.md">Contributing</a> •
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest"><img src="https://img.shields.io/github/v/release/MiguelMedeiros/ghostly?style=for-the-badge&label=Download&color=22d3ee" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="MIT License"></a>
</p>

---

## What is Ghostly?

Ghostly is an end-to-end encrypted, peer-to-peer messenger with a wallet and verifiable identities built in.

- Two people meet on the public Mainline DHT (Pkarr records), then talk directly over WebRTC, Iroh or HyperDHT.
- If no direct path works, short texts keep flowing over the DHT itself.
- History and keys stay on your device. There is no Ghostly message server and no account.

The protocol is specified in the open, one small document at a time: the [WISPs](docs/wisps/README.md).

## Get Ghostly

| Platform | How |
|---|---|
| **Web** (any browser, installs on a phone) | Open **[app.ghostly.tools](https://app.ghostly.tools)**. Nothing to install. |
| **Desktop** (macOS, Windows, Linux) | `.dmg`, `.exe` / `.msi`, `.AppImage` / `.deb` from the **[latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest)**. The app updates itself. |
| **Browser extension** (Chrome, Brave, Edge) | `ghostly-browser-extension-<version>.zip` from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest), loaded unpacked. |
| **CLI** (macOS, Linux, Windows) | `ghostly-cli-<platform>` binaries from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest). |
| **Self-hosted web** | `docker compose up -d` serves the web app on `localhost:8080`. See [WEB.md](docs/WEB.md). |

Step by step, checksums and signatures: [Installation](docs/INSTALLATION.md).

## Features

**Chat**
- One chat type and one invite: a `ghostly1…` code, link or QR code.
- Live peer to peer over WebRTC, Iroh or HyperDHT, with the DHT as the fallback. The chat header's connection icon shows how you are connected, and you can pick a transport or "DHT only" per chat.
- Rich text, @mentions in groups, link previews made by the sender, location cards, and cards for invites, Nostr keys, identities and payment codes.
- Voice messages, GIFs, emoji, message details, per-chat mute.
- Files of any size, resumable and checked by digest. Large files ask the receiver first.
- Voice and video calls, with screen sharing inside the call.
- Private groups and larger communities, joined by a link.

**Money**
- Wallets per network: **Mainnet** (real money) and **Testnet** (test coins) side by side, in tabs.
- Cashu ecash, Lightning, Spark, Ark (Arkade and Bark), Fedimint, on-chain Bitcoin and USDT. Which rail runs on which network: [Wallets](docs/WALLETS.md).
- Several Lightning cards per network, each backed by a source you choose (a Cashu mint, Fedimint, Breez, NWC, LND, Core Lightning or a WebLN wallet). Pays invoices, Lightning addresses and LNURL.
- Pay or request in a chat from the composer: **+ → Payment**.
- Mainnet spends ask for a clear confirmation. A wallet with money still on its way cannot be removed by accident. Testnet coins come from **Get test coins**, only when you ask.

**Identity**
- A profile per person, each with its own keys and a `did:dht`.
- Prove you also hold another identity: Nostr, Bluesky (AT Protocol), Pubky, a DID, a domain, SSH, OpenPGP or a Bitcoin address.
- Share an identity with one chat at a time. Contacts see it as an ID card with its public profile.

**Shared apps**
- Share a web app running on your machine (`localhost`) with a contact while you are online, over the chat's live connection. Desktop and the extension can share and open them; the web app cannot.

## How it works

```
 Alice                    Mainline DHT (Pkarr)                     Bob
   │── signed, encrypted record ──▶  rendezvous  ◀── signed, encrypted record ──│
   │◀══════════ live link: WebRTC · Iroh · HyperDHT (end-to-end encrypted) ═════▶│
   │               no live path? short texts keep going over the DHT            │
```

- **Keys:** a fresh key pair per chat, so no key ties your chats together.
- **Encryption:** every message is end-to-end encrypted. Relays and DHT nodes can see ciphertext, timing and IP addresses, never what you say.
- **Relays are helpers**, not servers that hold your chats. Desktop reads the DHT directly; a browser cannot, so the web app and the extension go through public Pkarr relays. A relay that misbehaves is skipped for a while (a circuit breaker per relay).
- **Local first:** history, keys and wallets live on the device, optionally behind a password.

More in [Architecture](docs/ARCHITECTURE.md), [Transports](docs/TRANSPORTS.md) and [Protocol](docs/PROTOCOL.md). The threat model and past audit fixes: [SECURITY.md](SECURITY.md) and [Security review](docs/SECURITY-REVIEW.md).

## Quick start

1. Open [app.ghostly.tools](https://app.ghostly.tools) or the Desktop app.
2. **New** → copy the invite link (or show its QR code) and send it to a friend.
3. They open it, or paste it under **Join**. The chat goes live as soon as you find each other.

## Build from source

Requirements: Node.js 22, Rust (stable) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for Desktop.

```bash
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly
npm install
```

| Build | Command |
|---|---|
| Desktop, development | `npm run tauri dev` |
| Desktop, release bundle | `npm run tauri build` |
| Web app | `npm run build:web` (output in `web/dist`) |
| Browser extension | `npm run build:extension` |
| CLI | `cargo build --release -p ghostly-cli` |

Tests and the rest of the workflow: [Contributing](CONTRIBUTING.md) and [Testing](docs/TESTING.md).

## Documentation

| Topic | Docs |
|---|---|
| Getting it | [Installation](docs/INSTALLATION.md) · [On the web](docs/WEB.md) · [Browser extension](docs/BROWSER.md) · [CLI](docs/CLI.md) |
| Using it | [Chat](docs/CHAT.md) · [Wallets](docs/WALLETS.md) · [Identities](docs/IDENTITIES.md) |
| How it works | [Architecture](docs/ARCHITECTURE.md) · [Transports](docs/TRANSPORTS.md) · [Protocol](docs/PROTOCOL.md) · [WISPs](docs/wisps/README.md) |
| Building on it | [SDK](docs/SDK.md) · [AI agents and bots](docs/AI-AGENTS.md) |
| Working on it | [Contributing](CONTRIBUTING.md) · [Testing](docs/TESTING.md) · [Releasing](docs/RELEASING.md) · [Security review](docs/SECURITY-REVIEW.md) |

## Troubleshooting

**macOS: "Ghostly.app is damaged and can't be opened".** macOS quarantines apps downloaded outside the App Store. Clear the flag, then open the app again:

```bash
sudo xattr -cr /Applications/Ghostly.app
```

Something else? [Open an issue](https://github.com/MiguelMedeiros/ghostly/issues). For a vulnerability, never open an issue: follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Built with 👻 by [@miguelmedeiros](https://github.com/miguelmedeiros).
