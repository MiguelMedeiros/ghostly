import type { Constraint, Dimension, Strength } from "./pairwise";

/**
 * What a Ghostly conversation can be made of, as data: the matrix generator
 * (pairwise.ts) combines these, the scenario (scenario.ts) acts them out.
 *
 * Two people per scenario: A creates the chat, B joins it (C joins a group when
 * there is one). The per-person dimensions (locale, viewport, restored profile)
 * apply to B, so every scenario is also a mixed pair — B in Portuguese on a
 * phone talks to A in English on a laptop.
 *
 * `requires` names infrastructure (requirements.ts): a value whose
 * infrastructure is not up is not dropped from the matrix, its block is
 * skipped with the reason and the scenario reported as partial.
 */

export interface Value {
  id: string;
  /** What it means, for the report and --list. */
  label: string;
  requires?: readonly string[];
}

export interface MatrixDimension extends Dimension {
  values: readonly Value[];
}

export const DIMENSIONS = [
  {
    id: "client",
    label: "clients (A↔B)",
    values: [
      { id: "web-web", label: "web app ↔ web app" },
      { id: "web-extension", label: "web app hosts, extension joins" },
      { id: "extension-web", label: "extension hosts, web app joins" },
      { id: "extension-extension", label: "extension ↔ extension" },
      // Desktop is driven through WebDriver (support/desktop.ts), on Linux: two apps side by side, each with
      // a home of its own. Desktop↔Desktop is the only pair where Iroh and HyperDHT can connect.
      { id: "desktop-web", label: "Desktop hosts, web app joins", requires: ["desktop"] },
      { id: "desktop-desktop", label: "Desktop ↔ Desktop", requires: ["desktop"] },
    ],
  },
  {
    id: "transport",
    label: "transport",
    values: [
      { id: "webrtc", label: "WebRTC preferred, fallback on (the default)" },
      { id: "webrtc-strict", label: "WebRTC only, fallback off on both sides" },
      { id: "native-fallback", label: "Desktop prefers Iroh with fallback: the pair settles on WebRTC" },
      { id: "iroh-only", label: "Desktop wants Iroh only, the web has none: refused cleanly, chat stays usable" },
      { id: "hyperdht-only", label: "Desktop wants HyperDHT only, the web has none: refused cleanly" },
    ],
  },
  {
    id: "delivery",
    label: "delivery",
    values: [
      { id: "live", label: "live stream; B reloads and comes back" },
      { id: "dht", label: "DHT only (chosen in the Connection menu); B away while A writes, then both back to live" },
      { id: "store-forward", label: "store-and-forward: A's S3 holds text and a picture while B is away", requires: ["s3"] },
    ],
  },
  {
    id: "wallet",
    label: "wallet mode",
    values: [
      { id: "mainnet", label: "Mainnet: the rail's UI only, no value moves" },
      { id: "testnet", label: "Testnet: a request and a direct send, paid" },
    ],
  },
  {
    id: "rail",
    label: "rail · source",
    values: [
      { id: "cashu", label: "Cashu ecash", requires: ["mint"] },
      { id: "ln-mint", label: "Lightning through the Cashu mint", requires: ["mint"] },
      { id: "ln-webln", label: "Lightning through a browser wallet (WebLN; in-memory unless GHOSTLY_WEBLN_REGTEST)" },
      { id: "ln-lnd", label: "Lightning through LND", requires: ["lnd"] },
      { id: "ln-cln", label: "Lightning through Core Lightning", requires: ["cln"] },
      { id: "ln-nwc", label: "Lightning through Nostr Wallet Connect", requires: ["nwc"] },
      { id: "ln-breez", label: "Lightning through Breez (Spark)", requires: ["breez"] },
      { id: "ark-arkade", label: "Ark through Arkade", requires: ["ark"] },
      { id: "bark", label: "Ark through Bark", requires: ["bark"] },
      { id: "btc-bdk", label: "Bitcoin on-chain through BDK", requires: ["bdk"] },
      { id: "btc-core", label: "Bitcoin on-chain through Bitcoin Core (Desktop only)", requires: ["bitcoind", "desktop"] },
      { id: "usdt", label: "USDT", requires: ["usdt"] },
    ],
  },
  {
    id: "identity",
    label: "identity proof",
    values: [
      { id: "none", label: "none" },
      { id: "nostr", label: "Nostr (NIP-07 signer)" },
      { id: "domain", label: "domain (DNS TXT)" },
      { id: "ssh", label: "SSH key" },
      { id: "pgp", label: "OpenPGP key" },
      { id: "bitcoin", label: "Bitcoin address (BIP-322)" },
      { id: "oidc", label: "OpenID Connect (the test issuer)" },
    ],
  },
  {
    id: "group",
    label: "group",
    values: [
      { id: "none", label: "none" },
      { id: "mesh", label: "A makes a group with B and C" },
      { id: "link", label: "C joins A's group through its link" },
    ],
  },
  {
    id: "profile",
    label: "B's profile",
    values: [
      { id: "fresh", label: "fresh" },
      { id: "restored", label: "backed up to a file and restored in a new browser, then goes on talking" },
    ],
  },
  {
    id: "locale",
    label: "B's language",
    values: [
      { id: "en", label: "English" },
      { id: "pt", label: "Português (Brasil)" },
    ],
  },
  {
    id: "viewport",
    label: "B's screen",
    values: [
      { id: "desktop", label: "1280×800" },
      { id: "phone", label: "390×844" },
    ],
  },
] as const satisfies readonly MatrixDimension[];

export type DimensionId = (typeof DIMENSIONS)[number]["id"];
export type ValueOf<D extends DimensionId> = Extract<(typeof DIMENSIONS)[number], { id: D }>["values"][number]["id"];
export type Combination = { [D in DimensionId]: ValueOf<D> };

// Constraints see partial assignments (pairwise.ts): an unassigned dimension is undefined and never rules anything out.
type Partial = Readonly<Record<string, string | undefined>>;
const isDesktop = (a: Partial) => a.client?.startsWith("desktop") === true;
const hasExtension = (a: Partial) => a.client?.includes("extension") === true;
const plain = (a: Partial, dimension: string, value: string) => a[dimension] === undefined || a[dimension] === value;

/**
 * What cannot exist, and why. A constraint only removes combinations that are
 * impossible (or that this harness cannot build yet, which says so): the must-fail
 * cases stay in, as values of their own.
 */
export const CONSTRAINTS: readonly Constraint[] = [
  {
    id: "native-transports-desktop-only",
    why: "Iroh and HyperDHT exist only in Desktop (src/desktop/nativeTransports.ts); a browser pair can only speak WebRTC",
    dims: ["client", "transport"],
    allows: (a) => a.client === undefined || a.transport === undefined || a.transport.startsWith("webrtc") || isDesktop(a),
  },
  {
    // support/desktop.ts speaks just enough WebDriver to click and read: the Desktop side of a scenario
    // pairs, talks and chooses a transport, nothing else. The rest stays at its plainest value, so the
    // pairs a Desktop scenario could not really exercise are not counted as covered by it.
    id: "desktop-drives-chat-only",
    why: "the Desktop peer (WebDriver) pairs, talks and picks a transport; wallets, proofs, groups, backups, locale and screen size are driven in the browser clients only",
    dims: ["client", "delivery", "wallet", "rail", "identity", "group", "profile", "locale", "viewport"],
    allows: (a) =>
      !isDesktop(a) ||
      (plain(a, "delivery", "live") && plain(a, "wallet", "mainnet") && plain(a, "rail", "cashu") && plain(a, "identity", "none") &&
        plain(a, "group", "none") && plain(a, "profile", "fresh") && plain(a, "locale", "en") && plain(a, "viewport", "desktop")),
  },
  {
    id: "bitcoin-core-desktop-only",
    why: "bitcoind answers no CORS: the Bitcoin Core source is reached through a Tauri command, Desktop only",
    dims: ["client", "rail"],
    allows: (a) => a.rail !== "btc-core" || a.client === undefined || isDesktop(a),
  },
  {
    // The browser wallet is window.webln in a page; the extension's wallet runs in its offscreen document.
    id: "webln-web-only",
    why: "WebLN is a page API (window.webln): the extension's wallet engine runs in its offscreen document, where no browser wallet injects one",
    dims: ["client", "wallet", "rail"],
    allows: (a) => !(a.rail === "ln-webln" && a.wallet === "testnet" && hasExtension(a)),
  },
  {
    // A proves the identity. NIP-07 is the page's own window.nostr: offered on the web and Desktop, never in
    // the extension, whose pages do not get another extension's (src/lib/nostr.ts); NIP-46 needs a bunker.
    id: "nip07-host-on-the-web",
    why: "the Nostr proof is signed by A through NIP-07, which the extension does not offer (another extension's window.nostr never reaches its pages)",
    dims: ["client", "identity"],
    allows: (a) => !(a.identity === "nostr" && a.client?.startsWith("extension")),
  },
  {
    // support/domain.ts answers DNS-over-HTTPS by routing the page's requests (context.route); the
    // extension verifies in its offscreen document, which routes never reach, and would ask the real resolvers.
    id: "test-domain-web-only",
    why: "the test domain's DNS is answered by context.route, which does not reach the extension's offscreen engine",
    dims: ["client", "identity"],
    allows: (a) => !(a.identity === "domain" && hasExtension(a)),
  },
  {
    id: "oidc-test-issuer-web-only",
    why: "the test OIDC issuer is compiled into the web build (VITE_OIDC_TEST_ISSUER); the extension build knows only the real providers, whose client ids Miguel registers",
    dims: ["client", "identity"],
    allows: (a) => !(a.identity === "oidc" && hasExtension(a)),
  },
];

/** Covered completely, not only pairwise: how people connect is where combinations break. */
export const STRENGTHS: readonly Strength[] = [{ dims: ["client", "transport", "delivery"] }];

export const SEED = 20260924;

export const valueOf = (dimension: DimensionId, value: string): Value => {
  const d = DIMENSIONS.find((x) => x.id === dimension);
  const v = (d?.values as readonly Value[] | undefined)?.find((x) => x.id === value);
  if (!v) throw new Error(`unknown value ${dimension}=${value}`);
  return v;
};
