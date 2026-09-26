// What the scenes show: an invite, the wallets' cards, the identities' cards and the chat's messages, as the app
// would have them. Nothing here is anyone's real key or account.
import type { IdCardContent } from "../../../src/components/identities/idCard";
import type { WalletCard } from "../../../src/components/walletCardTypes";
import type { ChatMessage } from "../../../src/lib/types";

/** The invite from the app's own tests (src/test), so the QR is a real one. */
export const INVITE = "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k";

/** A drawn portrait for the identity card's photo slot. */
export const PORTRAIT = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
<defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
<rect width="160" height="160" fill="url(#b)"/>
<path d="M22 160c4-34 28-52 58-52s54 18 58 52z" fill="#1f2640"/>
<path d="M62 100h36v14c0 10-36 10-36 0z" fill="#f2c7a5"/>
<ellipse cx="80" cy="72" rx="30" ry="34" fill="#f6d2b4"/>
<path d="M48 70c-4-30 14-46 34-46 24 0 36 18 32 44-6-14-16-22-34-22-16 0-26 10-32 24z" fill="#2b1d3f"/>
<path d="M50 66c-8 20-4 44 6 56-12-4-20-26-14-46z" fill="#2b1d3f"/>
<circle cx="69" cy="76" r="3.4" fill="#2b1d3f"/><circle cx="91" cy="76" r="3.4" fill="#2b1d3f"/>
<path d="M71 92c5 5 13 5 18 0" stroke="#b86b5a" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>`);

const card = (id: WalletCard["id"], name: string, balance: string, detail: string, status = "Ready", network: "mainnet" | "testnet" = "mainnet"): WalletCard<string> =>
  ({ id: `${id}:${network}`, rail: id, network, name, balance, detail, status, ready: true });

/** The deck, Cashu in the middle of the fan. */
export const MAINNET: WalletCard<string>[] = [
  card("lightning", "Lightning", "84,210 sats", "Via Alby Hub"),
  card("arkade", "Ark", "5,000 sats", "Arkade · Bitcoin"),
  card("bark", "Bark", "12,000 sats", "Second's Ark · Bitcoin", "Real bitcoin"),
  card("cashu", "Cashu", "21,000 sats", "Ecash · your mints"),
  card("spark", "Spark", "7,700 sats", "Spark · Bitcoin", "Real bitcoin"),
  card("bitcoin", "Bitcoin", "420,000 sats", "On-chain · BDK"),
  card("fedimint", "Fedimint", "Testnet only", "Federation ecash", "Not on Mainnet yet"),
  card("usdt", "USDT", "120.00 USDT", "Ethereum · via WDK"),
];
export const TESTNET: WalletCard<string>[] = [
  card("lightning", "Lightning", "50,000 test sats", "Invoices via Cashu", "Shared balance", "testnet"),
  card("arkade", "Ark", "100,000 test sats", "Arkade · mutinynet", "Ready", "testnet"),
  card("bark", "Bark", "30,000 test sats", "Second's Ark · signet", "Ready", "testnet"),
  card("cashu", "Cashu", "50,000 test sats", "Ecash · test mints", "Ready", "testnet"),
  card("spark", "Spark", "25,000 test sats", "Spark · regtest", "Ready", "testnet"),
  card("bitcoin", "Bitcoin", "1,000,000 test sats", "On-chain · Esplora", "Ready", "testnet"),
  card("fedimint", "Fedimint", "10,000 test sats", "Mutinynet federation", "Ready", "testnet"),
  card("usdt", "USDT", "500.00 TEST-USDT", "Sepolia · test token", "Ready", "testnet"),
];

const idCard = (patch: Partial<IdCardContent> & Pick<IdCardContent, "id" | "provider" | "label" | "subject" | "short">): IdCardContent => ({
  bound: patch.provider, category: "Your own key", attested: false, status: "verified", statusLabel: "Verified",
  validity: "Until 26 Sep 2027", issued: "26 Sep 2026", shared: "Shared in 3 chats", refusedBy: [], ...patch,
});
export const IDS: IdCardContent[] = [
  idCard({ id: "pubky", provider: "pubky", label: "Pubky", subject: "pk:8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo", short: "pk:8pinx…35ewo" }),
  idCard({ id: "nostr", provider: "nostr", label: "Nostr", subject: "npub1alice", short: "npub1x7a…4q9f", name: "Alice", photo: PORTRAIT }),
  idCard({ id: "atproto", provider: "atproto", label: "Bluesky", subject: "alice.bsky.social", short: "@alice.bsky.social", category: "Your account" }),
];

const at = new Date(2026, 8, 26, 9, 41).getTime();
/** The group chat, in the order the messages arrive. */
export const MESSAGES: (ChatMessage & { nickShown?: string })[] = [
  { id: "m1", sender: "me", text: "**Ghostly v1.0** is _live_ 🎉", timestamp: at, delivery: "delivered" },
  { id: "m2", sender: "peer", nick: "Alice", text: `Join us: https://ghostly.tools/#${INVITE}`, timestamp: at + 60_000 },
  { id: "m3", sender: "peer", nick: "Bo", text: "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0005", timestamp: at + 120_000 },
  { id: "m4", sender: "peer", nick: "Alice", text: "@Sam ship it! 🚀", timestamp: at + 180_000, mentions: [{ o: 0, l: 4, key: "me", name: "Sam", me: true }] },
  { id: "m5", sender: "me", text: "```ts\nawait ghostly.pair(invite)\n```", timestamp: at + 240_000, delivery: "delivered" },
];

export const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";
