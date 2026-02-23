# Architecture

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
