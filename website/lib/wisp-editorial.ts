import type { Level } from "./status";

/**
 * Editorial layer over the WISP drafts: the family a draft is presented in, a
 * one-line benefit, and its availability as checked in the code on `dev` (the
 * 1.0.0 release): "available" when the app runs it. Numbers, titles, status
 * and dependencies come from the documents, never from here.
 */
export type GroupId =
  | "meet"
  | "connect"
  | "talk"
  | "files"
  | "calls"
  | "pay"
  | "services"
  | "identity"
  | "keep"
  | "together"
  | "headless";

export const GROUPS: {
  id: GroupId;
  ranges: [number, number][];
  order?: string[];
  title: string;
  blurb: string;
  icon: string;
}[] = [
  {
    id: "meet",
    ranges: [[0, 3], [6, 99], [800, 899]],
    order: ["00", "01", "02", "03", "800", "801"],
    icon: "spark",
    title: "Meet",
    blurb: "The small core: rendezvous records, keys, invitations and agreeing on what both sides support.",
  },
  {
    id: "connect",
    ranges: [[100, 199]],
    icon: "route",
    title: "Connect",
    blurb: "Choosing a data path both peers share, and the adapters that provide one.",
  },
  {
    id: "talk",
    ranges: [[400, 499]],
    icon: "chat",
    title: "Chat",
    blurb: "One kind of chat: a live peer-to-peer link when one connects, short text through the DHT when none does, and items held in your own storage for a contact who is away.",
  },
  {
    id: "files",
    ranges: [[500, 599]],
    icon: "file",
    title: "Files",
    blurb: "Bounded, verified file transfer over the live link, or held for a contact who is away.",
  },
  {
    id: "calls",
    ranges: [[600, 699]],
    icon: "video",
    title: "Voice & video",
    blurb: "Real-time media coordinated separately from the data stream.",
  },
  {
    id: "pay",
    ranges: [[200, 299]],
    icon: "bolt",
    title: "Payments",
    blurb: "Negotiate a payment method, carry the request, let a wallet adapter do the rest.",
  },
  {
    id: "services",
    ranges: [[700, 799]],
    icon: "window",
    title: "Local services",
    blurb: "Let a contact open something running on your computer, and take it back.",
  },
  {
    id: "identity",
    ranges: [[300, 399]],
    icon: "badge",
    title: "Identity proofs",
    blurb: "Optional proofs that you control an outside identity. Never required to talk.",
  },
  {
    id: "keep",
    ranges: [[4, 5], [1000, 1099]],
    order: ["04", "05", "1000", "1001", "1002"],
    icon: "box",
    title: "Profiles & storage",
    blurb: "Separate lives on one device, sealed backups, and where those backups are kept.",
  },
  {
    id: "together",
    ranges: [[900, 999]],
    order: ["900", "902", "901"],
    icon: "group",
    title: "Groups",
    blurb: "Private groups of up to eight and communities of up to 256: text, a picture and payments between members.",
  },
  {
    id: "headless",
    ranges: [[1100, 1199]],
    icon: "terminal",
    title: "Headless & bots",
    blurb: "The app's own engine without a screen, driven by other programs on the same machine.",
  },
];

type Entry = {
  group?: GroupId;
  benefit: string;
  level: Level | null;
  note?: string;
  feature?: { label: string; href: string };
  video?: { src: string; poster?: string; chapters?: { at: number; title: string }[] };
};

const inApp = (anchor: string, label: string): { label: string; href: string } => ({ label, href: `/#${anchor}` });

export const editorial: Record<string, Entry> = {
  "00-process": {
    benefit: "How a WISP is written, reviewed and numbered, and what Draft, Proposed and Final mean.",
    level: null,
  },
  "01-ghost-core": {
    benefit: "Find a peer through small signed records on the Mainline DHT, without turning discovery into storage.",
    level: "available",
    note: "The rendezvous exists since the first release; the modular boundary is a proposal.",
    feature: inApp("dht", "The meeting on the DHT"),
  },
  "02-peer-keys": {
    benefit: "A fresh identity for every connection, and pinning the key of the person you paired with.",
    level: "available",
  },
  "03-capabilities": {
    benefit: "Both sides announce versioned abilities and only use what they have in common.",
    level: "available",
    note: "Every new chat announces its abilities in a record on the DHT before a live link exists, then agrees on them on the live link. Chats with Ghostly 0.4 contacts keep a fixed set.",
    feature: inApp("agree", "The agreement"),
  },
  "04-profiles": {
    benefit: "Keep separate lives on one device (chats, wallets, services and settings), never announced to contacts.",
    level: "available",
    note: "Web, desktop and extension. Switch from the account bar in one tap.",
    feature: inApp("space", "Your space"),
  },
  "05-backups": {
    benefit: "Bring a whole profile back from one passphrase-sealed bundle.",
    level: "available",
    note: "Web, desktop and extension. A restore always creates a new profile; nothing is overwritten.",
    feature: inApp("space", "Your space"),
  },
  "100-transports": {
    benefit: "Pick a data path both peers support, in order of preference; fall back only when both allow it.",
    level: "available",
    feature: inApp("alive", "The connection comes alive"),
  },
  "101-webrtc": {
    benefit: "Carry a session over a WebRTC data channel, the direct path browsers have.",
    level: "available",
    note: "Browser, extension and desktop, except Linux, whose webview has no WebRTC. May use STUN/TURN servers to get through networks.",
  },
  "102-iroh": {
    benefit: "Use an Iroh QUIC endpoint, with Ghostly authentication bound to the connection.",
    level: "available",
    note: "Experimental. Direct between desktop apps, tried from the first contact. The web app and extension use it through relays (n0's public ones unless you set others), so a web chat can reach a desktop.",
  },
  "103-hyperdht": {
    benefit: "Use an authenticated Noise stream found through HyperDHT.",
    level: "available",
    note: "Experimental. Between desktop apps, tried from the first contact. The web app and extension reach it only through a relay you set: none runs by default.",
  },
  "200-payments": {
    benefit: "Agree on a payment method and carry the request; the wallet adapter moves the value.",
    level: "available",
    note: "Methods are negotiated in every chat, and in groups between two members. Any wallet can pay a request from its QR code or link; it is settled only when the payee's own wallet sees the money.",
    feature: inApp("next", "Send sats"),
  },
  "201-cashu": {
    benefit: "Send and receive ecash tokens in the conversation; a mint you choose holds the funds.",
    level: "available",
    feature: inApp("wallets", "Wallets"),
  },
  "202-arkade": {
    benefit: "Review and approve an exact Ark payment through a pinned operator.",
    level: "available",
    note: "Experimental. New makes a Mainnet wallet or a Testnet one in one click; payment flows were exercised only on a local regtest network. There is no unilateral exit yet.",
    feature: inApp("wallets", "Wallets"),
  },
  "203-lightning": {
    benefit: "Carry a Lightning invoice in the chat and pay or receive it through the wallet.",
    level: "available",
    note: "Several Lightning cards per network, one of them the default for receiving: your Cashu mint or your own node or wallet (NWC, LND, Core Lightning, WebLN in the web app, Breez (with your own API key on Mainnet) or a Fedimint federation). Any other wallet can pay the invoice from its QR code.",
    feature: inApp("wallets", "Wallets"),
  },
  "204-bark": {
    benefit: "A second Ark provider (Second's Bark) beside Arkade, so Ark isn't tied to one implementation.",
    level: "available",
    note: "Experimental. Mainnet on Second's Bitcoin server, Testnet on their signet server; no unilateral exit yet. Not interchangeable with Arkade: its own payment method and capability.",
    feature: inApp("wallets", "Wallets"),
  },
  "205-lnurl": {
    benefit: "Pay a Lightning address (name@domain) or an LNURL from the wallet or straight from a chat, through your Lightning source.",
    level: "available",
    note: "Paying only: receiving on an address needs a server you run. The domain is named before anything is fetched, and the service must allow cross-origin reads.",
    feature: inApp("wallets", "Wallets"),
  },
  "2xx-spark": {
    benefit: "Pay a contact who also has Spark straight from wallet to wallet: instant, off-chain, no Lightning hop.",
    level: "available",
    note: "Experimental: Mainnet with your own Breez API key; Testnet runs on Breez's hosted regtest with no key. The same wallet can be your Lightning source. Number not yet assigned.",
    feature: inApp("wallets", "Wallets"),
  },
  "2xx-fedimint": {
    benefit: "Ecash from a federation of guardians you choose: in a chat, and Lightning through the federation's gateway.",
    level: "available",
    note: "Experimental, on Mainnet and Testnet; not yet tried with real funds. You see a federation's name, guardians and network before joining. Number not yet assigned.",
    feature: inApp("wallets", "Wallets"),
  },
  "300-peer-proofs": {
    benefit: "Optionally prove to one contact that you control an outside identity. Never required.",
    level: "available",
    note: "Rebuilt on 2026-09-23: a proof is made once in Profile → Identities, shared per chat only when you choose, withdrawable and revocable through a DHT record. Web, desktop, extension and the headless CLI.",
  },
  "301-nostr": {
    benefit: "An optional Nostr proof, and where a signer's authority ends.",
    level: "available",
    note: "Signed once with a NIP-07 browser extension (web app, desktop) or a NIP-46 remote signer. A proof, not a transport, and not permission to publish.",
  },
  "3xx-nostr-social": {
    group: "identity",
    benefit: "What a proven Nostr key lets a contact see (profile, follows, notes) and, if you turn it on, posting through your own signer.",
    level: "available",
    note: "Experimental. Loaded only on request, from relays you choose; publishing is off by default and each post is confirmed. Web, desktop and extension (NIP-46 only there). Number not yet assigned.",
  },
  "3xx-domain": {
    group: "identity",
    benefit: "Show a contact that you control a domain, with a DNS record or a file on your site.",
    level: "available",
    note: "Experimental. Looked up through a DNS-over-HTTPS resolver the contact chooses and re-checked after a day, so removing the record withdraws the proof. Number not yet assigned.",
  },
  "3xx-openpgp": {
    group: "identity",
    benefit: "Sign the statement once with your own gpg (a YubiKey works unchanged), and the contact verifies it locally.",
    level: "available",
    note: "Holding a key proves nothing about the name or email in its user ID, and the app says so. Number not yet assigned.",
  },
  "3xx-bitcoin": {
    group: "identity",
    benefit: "Prove you hold the key behind a Bitcoin address with one BIP-322 signature from your wallet.",
    level: "available",
    note: "Experimental. Checked on the device with no blockchain lookup; proves no balance, past payment or willingness to pay. Number not yet assigned.",
  },
  "3xx-ssh": {
    group: "identity",
    benefit: "An SSH key signs once with ssh-keygen; a GitHub or GitLab account counts through the keys it publishes.",
    level: "available",
    note: "Experimental. Never grants a server login. Number not yet assigned.",
  },
  "3xx-did": {
    group: "identity",
    benefit: "A decentralized identifier (did:key, did:jwk, did:dht or did:web) signs once with one of its keys, or a did:web publishes beside its did.json.",
    level: "available",
    note: "Experimental, under Advanced. Each contact resolves the DID again. Number not yet assigned.",
  },
  "3xx-did-dht": {
    group: "identity",
    benefit: "Every profile gets a public identifier of its own, a did:dht that any resolver reads from the DHT, with no Ghostly server.",
    level: "available",
    note: "Experimental. Its own key, never a chat's; it lists an identity only when you switch it on. Web, desktop and extension. Number not yet assigned.",
  },
  "3xx-oidc-proofs": {
    group: "identity",
    benefit: "Show a contact that an account at Google, Microsoft, Apple, GitLab or Twitch signed in for this conversation.",
    level: "planned",
    note: "Attested by the provider, not a key you hold; the contact trusts that company. Built, but not offered until the maintainer registers Ghostly's OAuth clients. Number not yet assigned.",
  },
  "3xx-atproto": {
    group: "identity",
    benefit: "Show a contact that you control a Bluesky (AT Protocol) account, checked from its signed repository without logging in.",
    level: "planned",
    note: "Approved once on your own server, asking only for Ghostly's records; the record is public. Built, and offered once the website's OAuth client document is live. Number not yet assigned.",
  },
  "302-pubky": {
    benefit: "Show a contact you hold a Pubky key: approve one request in Pubky Ring or Pubky Passport, and Ghostly writes a small proof file to your homeserver.",
    level: "available",
    note: "The proof is published, not signed: Ring and Passport approve Pubky auth requests only. Number not yet assigned.",
  },
  "303-keet": {
    benefit: "Investigate an optional relationship with a Keet identity.",
    level: "research",
    note: "Blocked on a signer API for existing accounts; number not yet assigned.",
  },
  "400-chat": {
    benefit: "One chat for everyone: the DHT to meet, a live link when one connects, the DHT again when none does.",
    level: "available",
    note: "Messages with storage receipts and retries. A first pairing with no direct path starts on the DHT, short texts fall back to it when a live link drops, and every chat returns to a live link by itself. You can keep a chat on the DHT only.",
    feature: inApp("next", "Chat"),
  },
  "401-paired-chat": {
    benefit: "The live session of every chat: pinned keys, a durable outbox, names and pictures, over WebRTC, Iroh or HyperDHT.",
    level: "available",
    note: "Every new chat on web, desktop and extension, calls included while it is live.",
    feature: inApp("next", "Chat"),
  },
  "402-legacy-chat": {
    benefit: "Chats with Ghostly 0.4 contacts keep working, calls included. A new chat never uses it.",
    level: "available",
  },
  "403-dht-text": {
    benefit: "The floor of every chat: very short text through DHT records when no live link is up. Bounded, not a mailbox.",
    level: "available",
    note: "256 bytes, retried for five minutes: the first contact of every chat, after a live link drops, or in a chat set to DHT only. Chats with 0.4 contacts: up to 500 bytes (WISP 402).",
  },
  "4xx-store-and-forward": {
    group: "talk",
    benefit: "Text, a picture or a payment request sent while a contact is away waits, sealed, in your own S3 bucket and reaches them when they are back.",
    level: "available",
    note: "Experimental, in chats with the switch on at both ends; web, desktop and extension. Picked up until seven days after you were last online. Ecash is never held. Number not yet assigned.",
  },
  "500-files": {
    benefit: "Send a file straight to a contact, checked and acknowledged on arrival.",
    level: "available",
    note: "Any size, with both people online; above 25 MB the receiver accepts first, and a transfer resumes where it stopped. Chats with 0.4 contacts: up to 100 MiB.",
    feature: inApp("next", "Send files"),
  },
  "501-paired-files": {
    benefit: "How files travel in every chat: negotiated, chunk by chunk, with integrity checks.",
    level: "available",
  },
  "502-legacy-files": {
    benefit: "File frames of chats with Ghostly 0.4 contacts, so they can still send and receive files.",
    level: "available",
  },
  "600-media": {
    benefit: "Voice, video and screen sharing, coordinated apart from the data stream.",
    level: "available",
    note: "In every chat while it is live, the Linux desktop included (with media of its own, its webview having no WebRTC). Not in groups.",
    feature: inApp("next", "Calls"),
  },
  "601-webrtc-media": {
    benefit: "One-to-one calls over WebRTC media, with compact call signaling.",
    level: "available",
    note: "Screen sharing needs a computer; phone browsers can't share a screen.",
  },
  "700-local-services": {
    benefit: "Let chosen contacts open an app or site running on your computer, while you are online.",
    level: "available",
    note: "Desktop app and extension, at both ends; not the web app. You choose which contacts see each app.",
    feature: inApp("next", "Share a local app"),
  },
  "701-http-services": {
    benefit: "HTTP requests and responses carried over the chat's data link.",
    level: "available",
    note: "Plain request/response. No WebSockets or streaming.",
  },
  "800-invite-join": {
    benefit: "Turn a private invitation into a mutually admitted connection.",
    level: "available",
    feature: inApp("invite", "The invitation"),
  },
  "801-invitation-profiles": {
    benefit: "The invitation formats clients actually produce: links, QR codes and connection strings.",
    level: "available",
    note: "One ghostly1… code, checked for typos, shared as text, a QR code or a ghostly.tools link that opens the app. Older codes are still read.",
    feature: inApp("invite", "The invitation"),
  },
  "900-group-sessions": {
    benefit: "How a group agrees on who is in it, locks out whoever left, and moves messages between members, never through the DHT.",
    level: "available",
    note: "Two profiles implemented: group-mesh/1 (private, up to eight members, one admin) and group-community/1 (a link anyone can open, up to 256). Text, a picture and payments between members; web, desktop and extension.",
  },
  "9xx-group-mesh": {
    group: "together",
    benefit: "Up to eight people, each pair on its own authenticated link, with a fresh group key whenever someone joins or leaves.",
    level: "available",
    note: "Text, a picture set by the admin, and payments between two members over their own link; files and calls are refused in groups. A member who was away catches up from each author's recent messages. Number not yet assigned.",
  },
  "9xx-group-community": {
    group: "together",
    benefit: "A group whose link is the way in: anyone who opens it joins, any member lets them in while the admin is away, up to 256 members.",
    level: "available",
    note: "Text, a picture and payments, sealed to the two members and carried by the hubs. Online members elect a few hubs that relay; whoever was away is caught up by whoever is there. The cap is what a headless load test measured. Number not yet assigned.",
  },
  "901-gossipsub": {
    benefit: "Evaluate GossipSub as a distribution layer for groups larger than the mesh.",
    level: "planned",
    note: "A later profile, after the mesh is measured; no adapter. Number not yet assigned.",
  },
  "1000-storage": {
    benefit: "Where sealed bundles are kept, separate from what goes into a backup.",
    level: "available",
    note: "Holds backups and, since store-and-forward, items sealed for an away contact.",
    feature: inApp("space", "Your space"),
  },
  "1001-local-storage": {
    benefit: "The simplest place: a file you keep. No account, no network.",
    level: "available",
    note: "Backups only: a file has no address to hand a contact, so it cannot hold messages.",
  },
  "1002-s3-storage": {
    benefit: "Any S3-compatible bucket (AWS, R2, B2, MinIO, Garage) holding only encrypted bundles.",
    level: "available",
    note: "Backups and held messages on every client. The bucket's CORS rules must allow the app (and GET from your contacts' apps, to hold).",
  },
  "11xx-headless": {
    group: "headless",
    benefit: "Run Ghostly without a screen for a bot: a daemon keeps a profile online, a JSON event stream says what arrived, and the ghostly command answers, pays and shares.",
    level: "available",
    note: "Experimental, the same engine as the apps on Node: ghostly1 invites, chats, groups, wallets, files, identity proofs and shared apps. Not on npm yet; no Bark or Fedimint wallets, and the DHT only through relays. Number not yet assigned.",
  },
};
