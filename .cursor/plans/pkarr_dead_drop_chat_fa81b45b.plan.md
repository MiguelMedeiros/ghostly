---
name: Pkarr Dead Drop Chat
overview: Build an ephemeral, encrypted, serverless chat app ("Dead Drop") using Pkarr. Two users communicate via encrypted TXT records published to the Mainline DHT through Pkarr relays, with messages that naturally expire when they stop being republished.
todos:
  - id: scaffold
    content: Scaffold Vite + React + TS project, install deps (@synonymdev/pkarr, tweetnacl, qrcode.react, react-router, tailwindcss)
    status: completed
  - id: lib-crypto
    content: Implement crypto.ts (NaCl secretbox encrypt/decrypt) and url.ts (encode/decode chat params from URL fragment)
    status: completed
  - id: lib-pkarr
    content: Implement pkarr.ts wrapper (init client, publish encrypted TXT records, resolve and parse TXT records)
    status: completed
  - id: lib-storage
    content: Implement storage.ts (localStorage persistence for chat history and keypair state)
    status: completed
  - id: hook-chat
    content: Implement useChat hook (send message, poll loop, message dedup, republish timer, burn)
    status: completed
  - id: pages
    content: Build Home page (create drop / paste invite), Share page (QR + links), and Chat page (message list + input)
    status: completed
  - id: components
    content: Build UI components (MessageBubble, MessageInput, QRCode, StatusIndicator, Header)
    status: completed
  - id: styling
    content: Apply dark spy-themed TailwindCSS styling, responsive layout, animations
    status: completed
  - id: integration-test
    content: "End-to-end test: create a drop, open invite in second tab, exchange messages via real Pkarr relays"
    status: pending
isProject: false
---

# Pkarr Dead Drop - Ephemeral Encrypted Chat

## Concept

A "dead drop" is a method of espionage tradecraft: two parties communicate through a secret location without ever meeting. This app recreates that concept digitally using Pkarr -- messages are published as encrypted DNS TXT records to the Mainline DHT (10M+ nodes), and expire naturally when not republished. No server, no accounts, no trace.

## Architecture

```mermaid
sequenceDiagram
    participant Alice as Alice (Browser)
    participant RelayA as Pkarr Relay
    participant DHT as Mainline DHT
    participant RelayB as Pkarr Relay
    participant Bob as Bob (Browser)

    Note over Alice: Creates chat, generates<br/>keypairA + keypairB + encKey
    Alice->>Alice: Keeps seedA + pubkeyB + encKey (creator URL)
    Alice->>Bob: Shares seedB + pubkeyA + encKey (invite URL/QR)

    Note over Alice: Writes message
    Alice->>Alice: Encrypt msg with encKey (NaCl secretbox)
    Alice->>RelayA: PUT /keypairA (TXT record with ciphertext)
    RelayA->>DHT: Store via BEP44

    Note over Bob: Polls for messages
    Bob->>RelayB: GET /pubkeyA
    RelayB->>DHT: Query
    DHT->>RelayB: Signed packet
    RelayB->>Bob: Encrypted TXT records
    Bob->>Bob: Decrypt with encKey, display message

    Note over Bob: Replies
    Bob->>RelayB: PUT /keypairB (encrypted reply)
    RelayB->>DHT: Store via BEP44

    Note over Alice: Polls for replies
    Alice->>RelayA: GET /pubkeyB
    RelayA->>Alice: Bob's encrypted reply
```



## Two-Channel Design

Each chat session uses **two Pkarr keypairs** (one per direction) and one **shared encryption key**:

- **keypairA**: Alice writes, Bob reads
- **keypairB**: Bob writes, Alice reads  
- **encKey**: 256-bit symmetric key for NaCl secretbox encryption

When creating a chat, the app generates all three and encodes them into two URLs:

- Creator URL: `/#/chat/<seedA_b64>/<pubkeyB_b64>/<encKey_b64>` (write to A, read from B)
- Invite URL: `/#/chat/<seedB_b64>/<pubkeyA_b64>/<encKey_b64>` (write to B, read from A)

The URL fragment (`#`) never leaves the browser -- it is never sent to any server.

## Message Format (DNS TXT Records)

Each message is a single DNS packet (~1000 byte limit) containing:

- `_msg` TXT = `base64url(nonce[24] + ciphertext)` -- the encrypted message
- `_ts` TXT = Unix timestamp in ms -- for ordering/dedup
- `_nick` TXT = `base64url(nonce[24] + encrypted_nickname)` -- optional sender name

Effective message capacity: ~700-800 characters per message (after DNS overhead, encryption nonce, and MAC).

Since each key only holds one DNS packet at a time (latest overwrites previous), the **DHT is used as a transport layer**. Full chat history is persisted in `localStorage` on each client.

## Tech Stack

- **Vite + React 19 + TypeScript** -- fast dev, modern tooling
- **TailwindCSS v4** -- utility-first styling, dark mode support
- `**@synonymdev/pkarr`** (`0.1.4-rc.2` on npm) -- WASM bindings for Pkarr (Keypair, SignedPacket builder, Client with relay support)
- `**tweetnacl`** + `**tweetnacl-util`** -- NaCl secretbox (XSalsa20-Poly1305) for message encryption
- `**qrcode.react**` -- QR code generation for sharing invite links
- **React Router** -- hash-based routing for chat URLs
- **No backend** -- 100% client-side, communicates only with public Pkarr relays (`relay.pkarr.org`, `pkarr.pubky.org`)

## Key Pkarr JS API (from `@synonymdev/pkarr`)

```typescript
// Keypair management
const keypair = new Keypair();
const restored = Keypair.from_secret_key(seedBytes); // restore from 32-byte seed
keypair.public_key_string(); // 52-char z-base32
keypair.secret_key_bytes();  // Uint8Array(32)
keypair.public_key_bytes();  // Uint8Array(32)

// Build and sign DNS packet
const builder = SignedPacket.builder();
builder.addTxtRecord("_msg", base64Ciphertext, 300);
builder.addTxtRecord("_ts", timestamp, 300);
const signedPacket = builder.buildAndSign(keypair);

// Publish and resolve via relays
const client = new Client(); // uses default relays
await client.publish(signedPacket);
const resolved = await client.resolve(publicKeyString);
// resolved.records[i].rdata.data -> TXT value
```

## Project Structure

```
pkarr-website/
  src/
    main.tsx                 -- Entry point, router setup
    App.tsx                  -- Root layout component
    pages/
      Home.tsx               -- Landing: create drop or paste invite
      Chat.tsx               -- Chat view: messages + input
      Share.tsx              -- Show invite link + QR code
    lib/
      pkarr.ts               -- Pkarr client wrapper (init WASM, publish, resolve)
      crypto.ts              -- Encryption/decryption (NaCl secretbox)
      url.ts                 -- Encode/decode chat params from URL fragment
      storage.ts             -- localStorage persistence (keypair, chat history)
      types.ts               -- TypeScript interfaces
    components/
      MessageBubble.tsx      -- Single message display
      MessageInput.tsx       -- Text input + send button
      QRCode.tsx             -- QR code with copy button
      StatusIndicator.tsx    -- Connection/polling status
      Header.tsx             -- App header with nav
    hooks/
      useChat.ts             -- Core hook: manages send/receive/poll loop
      usePkarr.ts            -- Pkarr client initialization
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  tailwind.config.ts
```

## UI Design

### Home Page

- Dark, minimal, "spy-themed" aesthetic
- Large title: "Dead Drop" with subtitle about ephemeral messaging
- Two actions: "Create a Drop" button and "Paste an invite link" input
- Brief explanation of how it works (3 bullet points)

### Share/Invite Page (after creating)

- Shows the invite URL (truncated, with copy button)
- Large QR code for the invite
- "Your link" (the creator link) also shown separately
- Warning: "Save your link -- it contains your private key and cannot be recovered"
- "Enter Chat" button

### Chat Page

- Clean chat interface with message bubbles (left = received, right = sent)
- Subtle timestamp on each message
- Text input at bottom with send button
- Status bar showing: polling interval, last sync time, connection status
- "Burn" button in header: stops republishing, lets messages expire
- Character counter showing remaining capacity (~800 chars)
- Visual indicator when a new message arrives

## Key Behaviors

- **Polling**: Resolve peer's key every 5 seconds; backoff to 15s when idle
- **Republishing**: Republish own latest message every 30 minutes (keeps it alive on DHT)
- **History**: All received messages stored in localStorage, keyed by chat session ID
- **Expiration**: Messages naturally expire from DHT after a few hours if not republished
- **Burn**: User can stop republishing at any time; message disappears from DHT within hours
- **Offline resilience**: If relay is unreachable, queue message and retry with exponential backoff

