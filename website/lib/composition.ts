import type { Level } from "./status";

/**
 * The pieces of the architecture, as blocks for the composer on /developers
 * and the map on /roadmap. Levels were checked in the code on `dev` (the 0.5.0
 * release): what runs there is "available"; see lib/wisp-editorial.ts for the
 * same rule. `wisps` point at the drafts by
 * file slug so a renumbering follows; `refs` at other reference documents.
 */
export type DimId = "base" | "transport" | "talk" | "pay" | "identity" | "services" | "keep" | "groups" | "ecosystem";

export const DIMS: { id: DimId; color: string; title: string }[] = [
  { id: "base", color: "#22d3ee", title: "Rendezvous, keys & negotiation" },
  { id: "transport", color: "#60a5fa", title: "Transports" },
  { id: "talk", color: "#a78bfa", title: "Chat, files & media" },
  { id: "pay", color: "#fbbf24", title: "Payments" },
  { id: "identity", color: "#f472b6", title: "Identity proofs & social" },
  { id: "services", color: "#2dd4bf", title: "Local services" },
  { id: "keep", color: "#4ade80", title: "Profiles, backup & storage" },
  { id: "groups", color: "#fb923c", title: "Groups" },
  { id: "ecosystem", color: "#94a3b8", title: "SDK, apps & catalogs" },
];

export type Block = {
  id: string;
  dim: DimId;
  name: string;
  level: Level;
  wisps: string[];
  /** Other reference documents (reader slugs) when no WISP number exists. */
  refs?: string[];
  enables: string;
};

const b = (id: string, dim: DimId, name: string, level: Level, wisps: string[], enables: string, refs?: string[]): Block => ({
  id,
  dim,
  name,
  level,
  wisps,
  refs,
  enables,
});

/** " · " that never starts a line: block names wrap as a whole. */
const D = " · ";

export const BLOCKS: Block[] = [
  // Rendezvous, keys & negotiation
  b("core", "base", "Ghost core", "available", ["01-ghost-core"], "Find a peer through small signed records on Pkarr / Mainline DHT. Desktop reads and writes the DHT itself; the web app, extension and CLI go through Pkarr relays, each behind a breaker."),
  b("keys", "base", "Peer keys", "available", ["02-peer-keys"], "A fresh participation key per connection; every chat pins the other side's key."),
  b("invite", "base", "Invitations", "available", ["800-invite-join", "801-invitation-profiles"], "Turn a private link or code into a mutually admitted connection. A copy of an invite cannot stop a chat that is already paired."),
  b("qrinvite", "base", "QR invitations", "available", ["801-invitation-profiles"], "The invitation as a QR code to scan: the same code as the one you copy."),
  b("ghostly1", "base", "ghostly1 invite", "available", ["800-invite-join", "801-invitation-profiles"], "One invite code, ghostly1…, checked for typos, and a ghostly.tools link that opens the app."),
  b("caps", "base", "Capabilities", "available", ["03-capabilities"], "Both sides offer versioned abilities (chat/1, files/2, payments-cashu/1, hold/1 …) and use only the ones they share."),

  // Transports
  b("webrtc", "transport", "WebRTC", "available", ["100-transports", "101-webrtc"], "A data channel in the browser, the extension and the desktop app, except on Linux, whose webview has no WebRTC."),
  b("iroh", "transport", "Iroh", "available", ["100-transports", "102-iroh"], "QUIC bound to Ghostly authentication: direct between desktop apps, and relay only in the web app, extension and CLI, through n0's public relays unless you set others. A web chat reaches a desktop app this way."),
  b("hyperdht", "transport", "HyperDHT", "available", ["100-transports", "103-hyperdht"], "An authenticated Noise stream found through HyperDHT, between desktop apps and the CLI. The web app and extension reach it only through a relay you set: none runs by default."),
  b("dhttext", "transport", "DHT text", "available", ["403-dht-text"], "The floor of every chat: very short text in DHT records when no live link is up. Bounded, not a mailbox."),
  b("tor", "transport", "Tor", "research", [], "Reaching peers over Tor. An open question, not a plan yet.", ["adapter-roadmap"]),

  // Chat, files & media
  b("chat", "talk", "Chat", "available", ["400-chat"], "One kind of chat: messages with storage receipts and retries, over a live link or through the DHT."),
  b("paired", "talk", "Chat sessions", "available", ["401-paired-chat", "501-paired-files"], "The live session of every chat: pinned keys, a durable outbox, names and pictures, negotiated files, calls and shared apps."),
  b("compat", "talk", "Compatibility chats", "available", ["402-legacy-chat", "502-legacy-files"], "Chats with Ghostly 0.4 contacts and the older Rust CLI keep their older wire: DHT text and, on a live link, files and calls. Never created for a new chat."),
  b("onechat", "talk", "DHT fallback and upgrade", "available", ["400-chat", "403-dht-text", "100-transports"], "A first pairing with no direct path starts on the DHT, and every chat moves to a live link by itself when one connects."),
  b("callsall", "talk", "Calls in every chat", "available", ["600-media", "401-paired-chat"], "Voice, video and screen sharing in the chat session while it is live, not only with Ghostly 0.4 contacts."),
  b("hold", "talk", "Held messages", "available", ["4xx-store-and-forward"], "Text, a file up to 8 MiB or a Cashu/Lightning request, held for an away contact in your own S3 bucket and found through a DHT pointer. Opt-in per chat; up to seven days after you were last online."),
  b("files", "talk", "Files", "available", ["500-files", "501-paired-files"], "Verified transfers of any size while both peers are online, picked up where they stopped; above 25 MB the receiver accepts first. A voice message is a file too."),
  b("media", "talk", "Voice & video", "available", ["600-media", "601-webrtc-media"], "One-to-one calls and screen sharing over WebRTC media, in every chat while it is live. Linux desktops, whose webview has no WebRTC, call with their own media, without screen sharing yet."),
  b("rich", "talk", "Rich messages", "available", [], "Rich text, @mentions in groups, link previews made by the sender, cards for invites, keys and payment codes, and a question before a secret like a seed is sent."),

  // Payments
  b("cashu", "pay", "Cashu", "available", ["200-payments", "201-cashu"], "Ecash tokens in the chat; a mint you choose holds the funds."),
  b("lightning", "pay", "Lightning", "available", ["203-lightning"], "Invoices in the chat, paid and received through your Cashu mint or your own Lightning source. Several Lightning cards per network, one of them the default for receiving."),
  b("lnproviders", "pay", "Lightning sources", "available", ["203-lightning"], "Your own node or wallet as the Lightning source: NWC, LND, Core Lightning, a browser wallet (WebLN, web app only), Breez (Mainnet with your own API key) or a Fedimint federation."),
  b("lnurl", "pay", "Lightning addresses", "available", ["205-lnurl"], "Pay name@domain or an LNURL through your Lightning source, from the wallet or from a chat. Paying only: receiving on an address needs a server."),
  b("external", "pay", "Pay from any wallet", "available", ["200-payments"], "A request paid by a wallet that is not Ghostly: QR, text or a lightning:/bitcoin: link. The payee's own source confirms it, never the payer's word."),
  b("onchain", "pay", `On-chain${D}BDK${D}Bitcoin Core`, "available", [], "Plain bitcoin in a chat, through a BDK wallet (test networks) or your own Bitcoin Core node (desktop).", ["adapter-roadmap"]),
  b("arkade", "pay", `Ark${D}Arkade`, "available", ["202-arkade"], "Exact Ark payments through a pinned operator: Arkade on Mainnet, mutinynet on Testnet. Experimental: payments were tested on regtest only, and there is no unilateral exit yet."),
  b("bark", "pay", `Ark${D}Bark`, "available", ["204-bark"], "A second Ark provider (Second's Bark): on Mainnet through Second's server, signet on Testnet, with no unilateral exit yet. Its own method and capability, not interchangeable with Arkade."),
  b("spark", "pay", "Spark", "available", ["2xx-spark"], "Spark to Spark, wallet to wallet, on the same seed as the Breez Lightning source. Mainnet with your own Breez API key; Testnet on regtest."),
  b("fedimint", "pay", "Fedimint", "available", ["2xx-fedimint"], "Ecash from a federation you join by invite code, in a chat and as a Lightning source through its gateway, on Mainnet and Testnet."),
  b("usdt", "pay", `USDT${D}WDK`, "available", [], "USDT on Ethereum through Tether WDK, signed locally. Experimental; no WISP number.", ["usdt-integration"]),
  b("testnet", "pay", "Wallets per network", "available", [], "A wallet per network, Mainnet and Testnet side by side; test coins come from Get test coins. Real money is always confirmed first, and a wallet with money still on its way is not removed by accident."),

  // Identity proofs & social
  b("proofs", "identity", "Identity proofs", "available", ["300-peer-proofs"], "Optionally prove to one contact that you control an outside identity: made once, shared per chat, revocable."),
  b("nostr", "identity", "Nostr", "available", ["301-nostr"], "A Nostr proof through a NIP-07 extension or a NIP-46 signer: a proof, not a transport."),
  b("proofkinds", "identity", `Domain${D}OpenPGP${D}SSH${D}Bitcoin`, "available", ["3xx-domain", "3xx-openpgp", "3xx-ssh", "3xx-bitcoin"], "Self-custodied proofs made once with your own tools: a DNS record, gpg, ssh-keygen, a wallet's BIP-322 signature."),
  b("oidc", "identity", "OpenID accounts", "planned", ["3xx-oidc-proofs"], "An account at Google, Microsoft, Apple, GitLab or Twitch, attested by that provider. Built, and offered once Ghostly's OAuth clients are registered."),
  b("atproto", "identity", "Bluesky / AT Protocol", "planned", ["3xx-atproto"], "A Bluesky (or any AT Protocol) account: approved once on your own server, published as one record in your repository, checked by contacts without logging in. Built; offered once the website's client document is live."),
  b("social", "identity", "Nostr social", "available", ["3xx-nostr-social"], "Behind a verified Nostr proof: a contact's profile, follows and notes, loaded when you ask. Publishing is off until you turn it on, and each post is confirmed."),
  b("pubprofiles", "identity", "Public profiles", "available", [], "A verified Nostr, Pubky or Bluesky identity shows its public name, picture and bio on its card, and a contact can be shown by it.", ["public-profiles"]),
  b("did", "identity", "DIDs", "available", ["3xx-did-dht", "3xx-did"], "Every profile has a did:dht of its own, listing an identity only if you switch it on; and a DID you control (did:key, did:jwk, did:dht, did:web) is proven like any identity."),
  b("pubky", "identity", "Pubky", "available", ["302-pubky"], "A Pubky key, approved once in Pubky Ring or Pubky Passport: the proof is a small file on its homeserver, which contacts read through the key's own records."),
  b("keet", "identity", "Keet", "planned", ["303-keet"], "A Keet relationship; blocked on a signer API for existing accounts."),

  // Local services
  b("http", "services", "Local HTTP apps", "available", ["700-local-services", "701-http-services"], "A contact opens a web app running on your computer; you choose who sees each app and can take it back. Desktop and extension."),

  // Profiles, backup & storage
  b("profiles", "keep", "Local profiles", "available", ["04-profiles"], "Separate lives on one device, never announced to contacts."),
  b("backups", "keep", "Backups", "available", ["05-backups"], "A whole profile in one passphrase-sealed bundle; a restore always creates a new profile."),
  b("storage", "keep", `Storage: file${D}S3`, "available", ["1000-storage", "1001-local-storage", "1002-s3-storage"], "Where sealed bundles wait: a file you keep or an S3-compatible bucket, which also holds messages for an away contact."),

  // Groups
  b("groups", "groups", "Groups", "available", ["900-group-sessions", "9xx-group-mesh", "9xx-group-community"], "Two kinds: a private group of up to eight, and a community of up to 256 whose link anyone can open, let in by any member through hubs the members elect. Text, a picture and payments between members; no files or calls. Keys change whenever someone leaves, so whoever is out reads nothing after. Web, extension and desktop."),
  b("gossipsub", "groups", "GossipSub", "planned", ["901-gossipsub"], "A candidate distribution layer for larger groups, off the DHT."),

  // SDK, apps & catalogs
  b("sdk", "ecosystem", "@ghostly/sdk", "available", [], "Write a wallet source or an identity proof outside the app, test it with the contract suites, and it joins the pickers as a plugin: no registry line. Not on npm yet.", ["sdk"]),
  b("headless", "ecosystem", "Headless CLI", "available", ["11xx-headless"], "`ghostly`: the app's own engine on Node for bots, driven through a daemon, a local socket and a JSON event stream. Spending real money needs --confirm-real. Not on npm yet."),
  b("apps", "ecosystem", "Apps & catalogs", "planned", [], "Mini-apps, games and independent catalogs, possibly with indexers.", ["adapter-roadmap"]),
  b("os", "ecosystem", "Self-hosted runtime", "planned", [], "An always-on personal node, even a Raspberry Pi, running your Ghostly.", ["adapter-roadmap"]),
];

/** What the headless `ghostly` CLI runs (docs/wisps/11xx-headless.md, "Parity with the app"). */
const CLI_BLOCKS = [
  "core", "keys", "invite", "ghostly1", "caps", "webrtc", "iroh", "hyperdht", "dhttext", "chat", "paired", "onechat", "files",
  "cashu", "lightning", "lnurl", "onchain", "arkade", "spark", "usdt", "testnet",
  "proofs", "nostr", "proofkinds", "did", "pubky", "http", "profiles", "backups", "groups", "headless",
];

export type PresetId = "cli" | "minimal" | "today" | "horizon";

export const PRESETS: { id: PresetId; blocks: (bl: Block) => boolean; title: string; blurb: string }[] = [
  {
    id: "minimal",
    blocks: (bl) => ["core", "keys", "invite", "webrtc", "chat"].includes(bl.id),
    title: "A minimal client",
    blurb: "Five pieces make a private text chat over WebRTC. Everything else can stay out.",
  },
  {
    id: "cli",
    blocks: (bl) => CLI_BLOCKS.includes(bl.id),
    title: "The headless CLI",
    blurb: "The app's engine without a screen, for bots: chats, groups, files, wallets and proofs through JSON events. No calls; Bark and Fedimint stay in the app.",
  },
  {
    id: "today",
    blocks: (bl) => bl.level === "available",
    title: "Ghostly today",
    blurb: "Everything the app runs: one-to-one chats, groups and communities, held messages, profiles and backups, a wallet per network with many ways to pay, identity proofs with public profiles, local apps, the SDK and the headless CLI.",
  },
  {
    id: "horizon",
    blocks: () => true,
    title: "Horizon",
    blurb: "Everything on the board, including what is planned or still a question. Not a promise.",
  },
];
