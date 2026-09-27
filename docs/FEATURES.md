# Features

What Ghostly does today, in one list. Each part has its own guide: [Chat](CHAT.md), [Wallets](WALLETS.md), [Identities](IDENTITIES.md), [Transports](TRANSPORTS.md). How it fits together: [Architecture](ARCHITECTURE.md).

## Chat

- One chat type and one invite: a `ghostly1…` code, link or QR code.
- Live peer to peer over WebRTC, Iroh or HyperDHT, with the DHT as the fallback. The chat header's connection icon shows how you are connected, and you can pick a transport or "DHT only" per chat.
- Replies, emoji reactions, a typing indicator (1:1, can be turned off) and WhatsApp-style delivery marks.
- Rich text with lists, quotes, headings and links, @mentions in groups, link previews made by the sender, location cards, and cards for invites, Nostr keys, identities and payment codes.
- Voice messages you can lock, pause, discard and play at 1.5× or 2×, and download as MP3. GIFs, emoji, message details, per-chat mute.
- Files of any size, resumable and checked by digest, pasted or dropped into the chat. Large files ask the receiver first; a stuck one can be sent again.
- Voice and video calls, with screen sharing inside the call (not yet on Linux Desktop, which calls with its own media: WebKitGTK has no WebRTC).
- Private groups and larger communities, joined by a link.

More: [Chat](CHAT.md).

## Money

- Wallets per network: **Mainnet** (real money) and **Testnet** (test coins) side by side, in tabs.
- Cashu ecash, Lightning, Spark, Ark (Arkade and Bark), Fedimint, on-chain Bitcoin and USDT. Which rail runs on which network: [Rails and networks](WALLETS.md#rails-and-networks).
- Several Lightning cards per network, each backed by a source you choose (a Cashu mint, Fedimint, Breez, NWC, LND, Core Lightning or a WebLN wallet). Pays invoices, Lightning addresses and LNURL.
- Pay or request in a chat from the composer: **+ → Payment**.
- Mainnet spends ask for a clear confirmation. A wallet with money still on its way cannot be removed by accident. Testnet coins come from **Get test coins**, only when you ask.

More: [Wallets and payments](WALLETS.md).

## Identity

- A profile per person, each with its own keys and a `did:dht`.
- Prove you also hold another identity: Nostr, Bluesky (AT Protocol), Pubky, a DID, a domain, SSH, OpenPGP or a Bitcoin address.
- Share an identity with one chat at a time. Contacts see it as an ID card with its public profile.

More: [Identities](IDENTITIES.md).

## Shared apps

- Share a web app running on your machine (`localhost`) with a contact while you are online, over the chat's live connection. Desktop and the extension can share and open them; the web app cannot.

More: [Calls and shared services](CHAT.md#calls-and-shared-services).

## Bots and scripts

- `ghostly` runs the app's own engine without a screen, for bots: `ghostly1` invites, groups, files, wallets, typing, replies, reactions, voice calls with the audio on a socket, and a JSON event stream ([packages/cli](../packages/cli/README.md)).
- `ghostly-cli` stays the compatibility client for bots built on v0.4 chats.

More: [CLI](CLI.md), [AI agents and bots](AI-AGENTS.md), [SDK](SDK.md).
