import type { Level } from "@/lib/status";

/**
 * The roadmap as a timeline: columns in the order things happen, rows by area.
 * No dates: a column is a stage, not a quarter. "Today" is where Ghostly
 * stands (the 1.0.0 release on `dev`); every column after it is future work,
 * checked against the code (see content/roadmap.ts).
 */
export const PHASES = ["now", "planned", "later"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_LEVEL: Record<Phase, Level> = {
  now: "available",
  planned: "planned",
  later: "planned",
};

type Item = string | { text: string; level: Level };
type Lane = { id: string; color: string; title: string; items: Partial<Record<Phase, Item[]>> };
type Timeline = {
  mapTitle: string;
  mapLead: string;
  timelineTitle: string;
  timelineLead: string;
  detailsTitle: string;
  grid: {
    presets: string;
    selectHint: string;
    enables: string;
    specs: string;
    noSpec: string;
    docs: string;
    included: string;
    close: string;
    stages: { title: string; play: string; pause: string; names: Record<Level, string> };
  };
  phases: Record<Phase, { title: string; sub: string }>;
  here: string;
  empty: string;
  lanes: Lane[];
};

export const timeline: Timeline = {
  mapTitle: "The map",
  mapLead: "Every piece of Ghostly, by area. Start from today, then move along the stages to see what comes next.",
  timelineTitle: "Stage by stage",
  timelineLead: "Left to right is the order things happen. No dates: a column is a stage, not a quarter.",
  detailsTitle: "Why this order? Dependencies and what \"done\" means",
  grid: {
    presets: "Stages",
    selectHint: "Tap any block to see what it lets you do and where it is specified.",
    enables: "What it enables",
    specs: "Specified in",
    noSpec: "No WISP yet",
    docs: "Reference",
    included: "{n} of {t} pieces",
    close: "Close",
    stages: {
      title: "Stages",
      play: "Play the evolution",
      pause: "Pause",
      names: { available: "Today", planned: "Planned", research: "Research" },
    },
  },
  phases: {
    now: { title: "Today", sub: "What the app does now" },
    planned: { title: "Next steps", sub: "In order of what they depend on" },
    later: { title: "Horizon", sub: "Long-term vision and open questions" },
  },
  here: "We are here",
  empty: "None",
  lanes: [
    {
      id: "talk",
      color: "#22d3ee",
      title: "Chat & connection",
      items: {
        now: ["One ghostly1 invite: code, QR, link", "DHT start and self-upgrade in every chat", "Chats: files of any size, payments, local apps", "Calls in every chat, while live, Linux included", "Iroh and HyperDHT on desktop; Iroh in browsers through relays", "Pairing progress you can watch", "Voice messages, rich text, mentions, link previews"],
        planned: ["Typing and presence", "Native iOS and Android apps", "Local network discovery, QUIC and WebSocket relay profiles"],
        later: [{ text: "Tor, libp2p, Pear components", level: "research" }],
      },
    },
    {
      id: "pay",
      color: "#fbbf24",
      title: "Payments",
      items: {
        now: ["Cashu and Lightning, from your own source too", "Lightning addresses, paying from any wallet", "Ark, Spark, Fedimint, USDT, on-chain (experimental)", "Mainnet and Testnet wallets side by side"],
        planned: ["Mainnet for Spark, Breez, BDK and Fedimint", "Unilateral exit for Ark", "Liquid and other rails"],
      },
    },
    {
      id: "keep",
      color: "#4ade80",
      title: "Profiles & backup",
      items: {
        now: ["Local profiles", "Sealed backups to a file or S3", "Messages held for an away contact"],
        planned: ["Scheduled backups and retention", "More storage places"],
      },
    },
    {
      id: "identity",
      color: "#f472b6",
      title: "Identity (optional)",
      items: {
        now: ["Proofs: Nostr · Pubky · domain · OpenPGP · SSH · Bitcoin address · DID", "Nostr social layer", "A did:dht per profile", "Public profiles on identity cards"],
        planned: ["Bluesky / AT Protocol accounts, once the site's OAuth client document is live", "OpenID accounts, once Ghostly's clients are registered", "Hardware wallets as signers, passkeys"],
        later: ["Keet, once it has a supported signing API", { text: "Pubky profiles and content", level: "research" }],
      },
    },
    {
      id: "groups",
      color: "#fb923c",
      title: "Groups",
      items: {
        now: ["Private groups (8) and communities (256)", "A group picture, payments between members"],
        planned: ["Files and calls in groups", "More than one admin"],
        later: ["Channels and topics", { text: "Group encryption beyond epoch keys (MLS)", level: "research" }],
      },
    },
    {
      id: "sdk",
      color: "#a78bfa",
      title: "SDKs & plugins",
      items: {
        now: ["Open contracts (WISP drafts)", "@ghostly/sdk and plugins", "The headless CLI and its event stream"],
        planned: ["Adapter manifests, the SDK and the CLI on npm", "Package authenticity and updates"],
        later: [{ text: "A permissioned plugin host", level: "research" }],
      },
    },
    {
      id: "eco",
      color: "#94a3b8",
      title: "Apps & self-hosting",
      items: {
        later: ["Mini-apps and P2P games", "Independent catalogs and indexers", "Always-on self-hosted runtime (even a Raspberry Pi)", "Ghostly OS"],
      },
    },
  ],
};
