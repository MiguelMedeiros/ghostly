# Architecture

> Ghostly is not a chat application. It is an ephemeral, identity-addressed peer-to-peer service layer. Chat, voice, video and local web applications are services on top of it, and they exist while you are online.

## Repository

| Path | What |
|---|---|
| [`packages/core`](../packages/core) | The Ghost protocol in platform-neutral TypeScript: identities, crypto, Pkarr records, service advertisements, WebRTC signaling, DataChannel framing, HTTP over the data link. Shared by every client. |
| [`packages/react`](../packages/react) | React hooks shared by the clients (`useWebRTC`). |
| [`src`](../src), [`src-tauri`](../src-tauri) | Ghostly Desktop (Tauri). Reaches the Mainline DHT directly through the Rust Pkarr client. |
| [`extension`](../extension) | Ghostly Browser (Chromium, Manifest V3). Builds the same UI as Desktop (`src/`) on top of a background peer, and reaches the DHT through Pkarr relays. See [BROWSER.md](BROWSER.md). |
| [`cli`](../cli) | Rust CLI and library for bots. |
| [`website`](../website) | ghostly.tools |

The wire format is specified in [PROTOCOL.md](PROTOCOL.md).

## Layers

```
 services      chat · voice · video · http · …
 data link     WebRTC DataChannel "ghostly/1", peer to peer, DTLS
 discovery     Pkarr signed packets in the Mainline DHT (directly, or through relays)
 identity      one Ed25519 keypair per link + a shared secretbox key
```

Discovery only helps peers find each other and exchange a WebRTC offer and answer. Application traffic goes over WebRTC. Relays, STUN and TURN are generic connectivity infrastructure: they see ciphertext and hold no Ghostly state. There is no Ghostly server.

## How It Works

Ghostly uses a clever combination of cryptography and the decentralized web:

| Step | What Happens |
|------|--------------|
| **1. Create Chat** | Generate Ed25519 keypairs + 256-bit symmetric key. No server involved! |
| **2. Share Invite** | URL contains seed + peer pubkey + encryption key. Fragment never leaves the app! |
| **3. Messages Travel** | Plaintext → Encrypt → DNS TXT → Sign → DHT (XSalsa20-Poly1305 + Ed25519 + BEP44) |
| **4. Messages Expire** | Stop republishing → TTL countdown (~5h) → Gone forever. No trace remains. |

## Tech Stack

- **[Pkarr](https://github.com/pubky/pkarr)** - Public Key Addressable Resource Records
- **[Mainline DHT](https://en.wikipedia.org/wiki/Mainline_DHT)** - 10M+ nodes, largest P2P network on Earth
- **NaCl Secretbox** - XSalsa20-Poly1305 authenticated encryption
- **Ed25519** - Digital signatures for message authenticity
- **BEP44** - BitTorrent DHT mutable items specification

## Message Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Sender    │     │  Mainline   │     │  Receiver   │
│   Device    │────▶│     DHT     │────▶│   Device    │
└─────────────┘     │  (10M+ nodes)│     └─────────────┘
                    └─────────────┘
```

1. **Encryption**: Message is encrypted with XSalsa20-Poly1305 using shared key
2. **Signing**: Encrypted payload is signed with Ed25519 private key
3. **Publishing**: Signed data is published to DHT as BEP44 mutable item
4. **Resolution**: Receiver queries DHT using sender's public key
5. **Verification**: Signature is verified with sender's public key
6. **Decryption**: Message is decrypted with shared symmetric key

## Security Model

- **End-to-End Encryption**: Only participants with the shared key can read messages
- **No Central Server**: No single point of failure or surveillance
- **Ephemeral by Design**: Messages expire after ~5 hours if not republished
- **Forward Secrecy**: Each chat session uses unique keys
