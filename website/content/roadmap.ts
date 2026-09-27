import type { Level } from "@/lib/status";

/**
 * The public roadmap: tracks in dependency order, never dates. It starts after
 * 1.0: "Now" is a short baseline of what the app already does, and "Next" is
 * only work that is not built. Checked against the code on `dev`.
 */
type Track = {
  id: string;
  n: string;
  title: string;
  why: string;
  now: { text: string; level: Level }[];
  next: { text: string; level: Level }[];
  gate: string;
  after: string[];
};

export const roadmap = {
  meta: {
    title: "Roadmap",
    description:
      "Where Ghostly goes after 1.0, in order and with dependencies: richer chats, more ways to pay, optional identities, groups, storage, SDKs and plugins, independent apps and a self-hosted runtime. No invented dates.",
  },
  eyebrow: "Public roadmap",
  title: "The ghost keeps learning.",
  lead: "It started small, learned to find someone, then new ways to talk and to trade value. What comes next is ordered by what it depends on, not by dates we'd have to invent.",
  rules: [
    "No dates. Order and dependencies only.",
    "What already exists is marked as such, not listed as future work.",
    "A candidate is not a commitment. Crediting a technology is not a partnership.",
  ],
  now: "Where it stands",
  next: "Next",
  gate: "Before it's called done",
  after: "Builds on",
  tracks: [
    {
      id: "talk",
      n: "01",
      title: "Talk in more ways",
      why: "Every new chat is the same kind: it comes from one ghostly1 invite, starts on the DHT when no direct path exists and goes live by itself. Next is what a chat shows about the other person, and more clients.",
      now: [
        { text: "One ghostly1 invite code, a QR and a ghostly.tools link", level: "available" },
        { text: "Chats with pinned keys, files of any size, payments and local apps", level: "available" },
        { text: "A chat with no direct path starts on the DHT and goes live by itself; short texts over the DHT when the live link drops", level: "available" },
        { text: "Calls and screen sharing in every chat, while it is live; Linux desktops call with their own media", level: "available" },
        { text: "Pairing progress you can watch while two apps find each other", level: "available" },
        { text: "Voice messages, rich text, mentions, link previews and cards for invites, payments and identities", level: "available" },
        { text: "A headless CLI for bots that joins the same chats", level: "available" },
      ],
      next: [
        { text: "Typing and presence, each a capability of its own that you can keep private", level: "planned" },
        { text: "Native apps for iOS and Android (route to be decided)", level: "planned" },
      ],
      gate: "Every client tested against every other one, on each transport it offers.",
      after: [],
    },
    {
      id: "pay",
      n: "02",
      title: "More ways to pay",
      why: "One payment agreement, many wallets. Each method keeps its own rules and its own risks.",
      now: [
        { text: "Mainnet and Testnet wallets side by side, a confirmation before real money moves", level: "available" },
        { text: "Cashu and Lightning, through the mint or your own sources (NWC, LND, Core Lightning, WebLN), several Lightning cards per network", level: "available" },
        { text: "Lightning addresses, and paying a request from any wallet", level: "available" },
        { text: "Ark (Arkade and Bark), Spark, Fedimint, USDT and on-chain bitcoin, experimental; BDK on test networks only", level: "available" },
      ],
      next: [
        { text: "Mainnet for Spark, Breez, BDK and Fedimint, once reviewed with real money in mind", level: "planned" },
        { text: "Unilateral exit for Ark", level: "planned" },
        { text: "Liquid and other rails", level: "planned" },
      ],
      gate: "Disposable-network settlement, fee limits, unknown-result reconciliation, and recovery or exit tested before any mainnet claim.",
      after: ["talk"],
    },
    {
      id: "reach",
      n: "03",
      title: "Reach each other in more places",
      why: "New transports widen where two people can meet. Each one is an adapter both sides must support, never a silent bridge.",
      now: [
        { text: "WebRTC (not on Linux desktops); Iroh and HyperDHT between desktop apps", level: "available" },
        { text: "Iroh in the browser through n0's relays; HyperDHT there only through a relay you set", level: "available" },
      ],
      next: [
        { text: "Local network discovery, generic QUIC and WebSocket relay profiles", level: "planned" },
        { text: "Tor, libp2p, Pear / Holepunch components", level: "research" },
      ],
      gate: "Each adapter tested on its own platforms, with its relays and privacy trade-offs stated.",
      after: ["talk"],
    },
    {
      id: "keep",
      n: "04",
      title: "Keep things, bring them back",
      why: "Profiles, backups and held messages exist. Next is making recovery routine.",
      now: [
        { text: "Local profiles, sealed backups to a file or S3, messages held for an away contact", level: "available" },
      ],
      next: [
        { text: "Scheduled backups and retention", level: "planned" },
        { text: "More storage places (WebDAV, Blossom and others), for backups and held messages", level: "planned" },
      ],
      gate: "Restore drills across devices and versions, without overwriting anything.",
      after: ["talk"],
    },
    {
      id: "identity",
      n: "05",
      title: "Bring an identity, only if you want",
      why: "Nobody needs a public identity to talk. Proofs are optional, several can coexist, and you choose what each contact sees.",
      now: [
        { text: "Proofs made once, shared per chat: Nostr, Pubky (approved in Pubky Ring or Passport), a domain, an OpenPGP or SSH key, a Bitcoin address, a DID", level: "available" },
        { text: "Nostr social layer: profile, follows and notes; posting off by default", level: "available" },
        { text: "A did:dht for every profile, listing only the identities you switch on", level: "available" },
        { text: "Public profiles on identity cards, and a contact shown as one of their identities", level: "available" },
      ],
      next: [
        { text: "Bluesky / AT Protocol accounts: built, blocked until the website's OAuth client document is live on ghostly.tools", level: "planned" },
        { text: "OpenID accounts (Google, Microsoft, Apple, GitLab, Twitch): built, blocked until Ghostly's OAuth clients are registered", level: "planned" },
        { text: "Hardware wallets as signers, and passkeys", level: "planned" },
        { text: "Keet, blocked until it offers a supported signing API", level: "planned" },
        { text: "Pubky profiles and content", level: "research" },
      ],
      gate: "Sessions without any proof still work. Proving a key never implies importing a graph or permission to publish.",
      after: ["talk"],
    },
    {
      id: "groups",
      n: "06",
      title: "From a conversation to a community",
      why: "Groups need membership, roles and distribution designed together, off the DHT.",
      now: [
        { text: "Private groups of up to eight and communities of up to 256: text, a picture and payments between members", level: "available" },
      ],
      next: [
        { text: "Files and calls in groups, each a capability of its own", level: "planned" },
        { text: "More than one admin, member key updates", level: "planned" },
        { text: "Channels, topics and gated access", level: "planned" },
        { text: "Group encryption beyond the epoch-key scheme (MLS)", level: "research" },
      ],
      gate: "Membership authority, removal, partitions, abuse limits and recovery tested.",
      after: ["talk", "identity"],
    },
    {
      id: "sdk",
      n: "07",
      title: "SDKs, adapters and plugins",
      why: "Let others build pieces without forking the app. A plugin is packaging; the contract stays a WISP.",
      now: [
        { text: "Contracts as WISP drafts, @ghostly/sdk in the repository (an adapter registers as a plugin), and a headless CLI with an event stream for bots", level: "available" },
      ],
      next: [
        { text: "Adapter manifests, and the SDK and the CLI published on npm", level: "planned" },
        { text: "Package authenticity and updates", level: "planned" },
        { text: "A permissioned plugin host", level: "research" },
      ],
      gate: "Malicious-plugin tests, provenance and an update policy.",
      after: ["talk"],
    },
    {
      id: "apps",
      n: "08",
      title: "Apps and catalogs",
      why: "Mini-apps, peer-to-peer games, commerce, interfaces for specific contracts, all found through independent catalogs.",
      now: [{ text: "Nothing yet", level: "planned" }],
      next: [
        { text: "Mini-apps and games", level: "planned" },
        { text: "Independent catalogs, several indexers, perhaps an indexer contract", level: "planned" },
        { text: "Reputation and optional paid apps", level: "planned" },
      ],
      gate: "No single catalog becomes mandatory.",
      after: ["sdk", "pay"],
    },
    {
      id: "os",
      n: "09",
      title: "A Ghostly you can host",
      why: "An always-on runtime (even a Raspberry Pi at home) so services and presence don't depend on an open tab.",
      now: [{ text: "Vision only", level: "planned" }],
      next: [
        { text: "Self-hosted 24h runtime", level: "planned" },
        { text: "Ghostly OS", level: "planned" },
      ],
      gate: "Measured hardware needs, secure administration, backup, reboot and upgrade tests.",
      after: ["keep", "sdk"],
    },
  ] as Track[],
  inventory: {
    title: "Every possibility, classified",
    lead: "From the adapter roadmap in the repository: transports, rails, providers, identities, hardware, storage and apps. Open any entry for the source notes.",
    source: "Read the full adapter roadmap",
    sourceStatus: "as written in the source",
    /** The source's statuses that the three levels don't name; shown before the source's note. */
    states: { "In implementation": "In implementation", Blocked: "Blocked" },
  },
};

export type RoadmapCopy = typeof roadmap;
