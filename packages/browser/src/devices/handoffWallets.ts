import { walletNetworkOf, type DeviceKind, type PaymentReview, type WalletNetwork } from "@ghostly/core";
import { WALLET_TYPES, type NetworkWalletsView, type WalletType, type WalletView } from "../shared/types";
import { CASHU_MINT_SOURCE } from "../engine/paymentAdapters/providers/cashuMint";

/*
 * Wallets in a handoff (WISP 06 § Wallets), phase 1: what each wallet does when the profile moves, decided wallet by
 * wallet from what the active device sees. A pure function: the engine reads the view and the records, this says what
 * moves, what stays on its home device, and what keeps the profile here now.
 *
 * - **Moves**: Cashu (its proofs are in the profile's database), Spark and the Breez Lightning source (the phrase moves,
 *   the database is rebuilt from the operators), Lightning through NWC and Core Lightning, LND without a pinned
 *   certificate (or with one, to a Desktop), on-chain BDK. The taker opens them once its turn settled.
 * - **Stays home**: Ark through Arkade (until its move test passes), Bark, Fedimint, USDT, Bitcoin Core, LND with a
 *   pinned certificate to anything but a Desktop, and any wallet whose SDK pin differs between the two devices. Its
 *   record moves marked with its home device; no other device opens it. Ark and Bark coins expire: the earliest expiry
 *   is carried with the mark, and a handoff to a device that is not the home is refused under 3 days from it.
 * - **Nothing to move**: the browser's own wallet (WebLN).
 *
 * Testnet first: a wallet of a type that moves holds no Mainnet money in a handoff (`MAINNET_MOVES` lists the types the
 * owner let move on Mainnet; none yet). An empty Mainnet wallet of such a type moves as a record.
 *
 * The strict check of part 7 stays as the net under all of it, failing closed: a wallet kind or a provider this build
 * does not know, a field it does not name, an amount in a place it does not name, a wallet that moves or keeps
 * expiring coins here and cannot be read now, and a view from before the wallets were read once.
 */

/**
 * `wallet`: something this build cannot judge (an unknown kind, provider or field, an amount in an unnamed place).
 * `loading`: a wallet whose holdings or coin expiry cannot be read now. `payment`: a payment call that has not
 * returned, or a Cashu swap in its lock. `mainnet`: Mainnet money in a wallet whose type does not move on Mainnet yet.
 * `expiry`: Ark or Bark coins that expire in under 3 days, and the taker is not their home.
 */
export type WalletHandoffProblem = "wallet" | "payment" | "loading" | "mainnet" | "expiry";

/** What a wallet does in a handoff. */
export type WalletRoute = "moves" | "home" | "none";

/** The home device of a wallet that stays home, as its record carries it. */
export interface WalletHome {
  /** The home device's signing key, base64url. */
  key: string;
  /** Ark and Bark: when the earliest coin expires (ms), as the home device last read it. */
  expiresAt?: number;
}

/** What the giver knows of the taker: its signing key, and from its `handoff-hello` its kind and SDK pins. */
export interface HandoffTakerFacts {
  key: string;
  kind?: DeviceKind;
  pins?: Record<string, string>;
}

export interface HandoffWalletFacts {
  view: WalletView;
  /** The wallets were read at least once since the engine started (a view before that says nothing about them). */
  read: boolean;
  /** This device's signing key, base64url. */
  ownKey: string;
  ownPins: Record<string, string>;
  /** Unknown before the taker said hello (a push asked before its session): then no pin differs. */
  taker?: HandoffTakerFacts;
  /** The home marks the records carry, by wallet id (`<type>:<network>`, `lightning:<network>:<card>`). */
  homes: Record<string, WalletHome>;
  now: number;
  /** The Lightning cards (wallet ids) on LND with a pinned certificate: the engine reads it from the sealed settings. */
  pinned?: ReadonlySet<string>;
  /** A payment call that has not returned, or a Cashu swap inside its per-mint lock. */
  executing?: boolean;
  /** The check after the stop: reviews not approved were cancelled, so one left `pending` keeps the profile here. */
  final?: boolean;
}

/** One wallet of the profile and what it does. */
export interface PlannedWallet {
  id: string;
  type: WalletType;
  network: WalletNetwork;
  card?: string;
  route: WalletRoute;
  /** `home`: its home device, and its coins' earliest expiry. */
  home?: WalletHome;
  /** Moves, and runs on the Breez SDK (Spark, the Breez Lightning source): the giver deletes its Breez database. */
  breez?: true;
}

export interface WalletHandoffRefusal {
  why: WalletHandoffProblem;
  /** Where in the view (a path, never an amount), for a log line. */
  at: string;
  /** The wallet it is about, when one is. */
  wallet?: WalletType;
  network?: WalletNetwork;
  /** `expiry`: when its coins expire. */
  expiresAt?: number;
}

export interface HandoffWalletPlan {
  refusal: WalletHandoffRefusal | null;
  wallets: PlannedWallet[];
}

/** Wallet types the owner let move on Mainnet (WISP 06 § Decisions, "Mainnet money"). None yet: Testnet first. */
export const MAINNET_MOVES: ReadonlySet<WalletType> = new Set<WalletType>();

/** Ark via Arkade moves once its move test passes (WISP 06 § Wallets); until then it stays home. */
export const ARKADE_MOVES = false;

/** A handoff away from home is refused when coins there expire sooner than this (WISP 06 § Wallets that stay home). */
export const EXPIRY_REFUSE_MS = 3 * 24 * 60 * 60_000;

/** Ark and Bark: about ten minutes a block, for an expiry the SDK gives in blocks. */
export const BLOCK_MS = 10 * 60_000;

/** The Lightning sources by what they do in a handoff. A source not named here is not judged: refused. */
const LIGHTNING_MOVES = new Set(["nwc", "core-lightning", "fake-lightning", CASHU_MINT_SOURCE]);
const ONCHAIN_MOVES = new Set(["bdk", "fake-onchain"]);

/** The SDK pin a wallet type runs on (`WALLET_SDK_PINS`), whose difference between two devices keeps it home. */
const PIN_OF: Partial<Record<WalletType, string>> = { arkade: "ark", bark: "bark", spark: "breez", fedimint: "fedimint" };

/** An amount that may be money: any number above zero, numeric text above zero, or anything that is not a number. */
export function money(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return !(value <= 0);
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "string") { const n = Number(value.trim() || "0"); return !(n <= 0); }
  return true;
}

/** Every field of any wallet view that holds an amount, known to this build. */
const AMOUNTS = new Set(["balance", "pending", "spendable", "incoming", "recoverable", "sweeping", "small", "exiting", "onchain", "unconfirmed", "gasBalance"]);

/**
 * A last net: any amount field anywhere in `value` that may be money, as the path to it. An amount field that holds a
 * list or a record is looked into, not taken for an amount.
 */
function anyAmount(value: unknown, path: string, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) { const found = anyAmount(item, `${path}[${i}]`, depth + 1); if (found) return found; }
    return null;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    // A flag under one of those names (a capability: `balance: true`) is no amount.
    if (AMOUNTS.has(key) && (typeof inner === "number" || typeof inner === "string" || typeof inner === "bigint") && money(inner)) return `${path}.${key}`;
    if (key === "awaiting" && Array.isArray(inner) && inner.length > 0) return `${path}.${key}`;
    if (key === "history" || key === "recent") continue;
    const found = anyAmount(inner, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Every field of a network's wallets, and whether this check reads it. A wallet kind added to `NetworkWalletsView`
 * later fails the typecheck here until it is handled; a view that carries a field this build does not name is refused.
 */
export const NETWORK_FIELDS: Readonly<Record<keyof NetworkWalletsView, "checked" | "past">> = {
  mints: "checked", balance: "checked", awaiting: "checked", ark: "checked", bark: "checked", fedimint: "checked", spark: "checked", usdt: "checked",
  lightning: "checked", lightnings: "checked", bitcoin: "checked", history: "past", feesPaid: "past",
};

/** The fields of the whole view the plan reads (or that hold no money); anything else is looked through for amounts. */
const VIEW_FIELDS = new Set<string>([...Object.keys(NETWORK_FIELDS), "networks", "wallets", "offers", "intents", "backupReminders"]);

/** A wallet set up and not read since it opened says 0 for a balance it never read. */
const unread = (wallet: { configured: boolean; locked: boolean; read?: true; error?: string } | undefined) => !!wallet?.configured && (wallet.locked || !!wallet.error || !wallet.read);

/** When a Bark wallet's or an Ark wallet's first coin expires, from what its view says; undefined when it does not say. */
export function coinsExpireAt(type: "arkade" | "bark", net: NetworkWalletsView, now: number): number | undefined {
  if (type === "arkade") return typeof net.ark?.expiresAt === "number" ? net.ark.expiresAt : undefined;
  const left = net.bark?.expiry?.blocksLeft;
  return typeof left === "number" && Number.isFinite(left) ? now + Math.max(0, left) * BLOCK_MS : undefined;
}

/** What one wallet holds, as paths to amounts that may be money. */
function held(fields: [string, unknown][]): string | null {
  return fields.find(([, amount]) => money(amount))?.[0] ?? null;
}

interface Candidate {
  id: string; type: WalletType; network: WalletNetwork; card?: string; at: string;
  /** Its class in phase 1, before its home mark, pins and the taker are looked at. */
  route: WalletRoute | "unknown";
  breez?: true;
  /** Paths to its amounts. */
  amounts: [string, unknown][];
  /** Its holdings cannot be read now. */
  unreadable: boolean;
}

/** The wallets of one network, with the class each has in phase 1. */
function candidates(net: NetworkWalletsView, network: WalletNetwork, at: string, taker: HandoffTakerFacts | undefined, pinnedCards: ReadonlySet<string>): Candidate[] {
  const list: Candidate[] = [];
  const awaiting = net.awaiting ?? [];
  const waits = (type: WalletType, card?: string) => awaiting.flatMap((item, i) => item.type === type && (card === undefined || item.card === card) ? [[`${at}.awaiting[${i}]`, item.amount > 0 ? item.amount : 1] as [string, unknown]] : []);
  if (net.mints.length || money(net.balance)) {
    list.push({
      id: `cashu:${network}`, type: "cashu", network, at, route: "moves", unreadable: false,
      amounts: [[`${at}.balance`, net.balance], ...net.mints.flatMap((mint, i) => [[`${at}.mints[${i}].balance`, mint.balance] as [string, unknown], ...(mint.awaiting ?? []).map((_, j) => [`${at}.mints[${i}].awaiting[${j}]`, 1] as [string, unknown])]), ...waits("cashu")],
    });
  } else if (awaiting.some((item) => item.type === "cashu")) list.push({ id: `cashu:${network}`, type: "cashu", network, at, route: "moves", unreadable: false, amounts: waits("cashu") });
  const { ark, bark, fedimint, spark, usdt, bitcoin } = net;
  if (ark?.configured) list.push({
    id: `arkade:${network}`, type: "arkade", network, at: `${at}.ark`, route: ARKADE_MOVES ? "moves" : "home", unreadable: unread(ark),
    amounts: [[`${at}.ark.balance`, ark.balance], [`${at}.ark.incoming`, ark.incoming], [`${at}.ark.recoverable`, ark.recoverable], [`${at}.ark.sweeping`, ark.sweeping], [`${at}.ark.small`, ark.small], ...waits("arkade")],
  });
  if (bark?.configured) list.push({
    id: `bark:${network}`, type: "bark", network, at: `${at}.bark`, route: "home", unreadable: unread(bark),
    amounts: [[`${at}.bark.balance`, bark.balance], [`${at}.bark.pending`, bark.pending], [`${at}.bark.exiting`, bark.exiting], [`${at}.bark.onchain`, bark.onchain], ...waits("bark")],
  });
  if (fedimint && (fedimint.federations.length || money(fedimint.balance))) list.push({
    id: `fedimint:${network}`, type: "fedimint", network, at: `${at}.fedimint`, route: "home",
    unreadable: !!fedimint.error || fedimint.federations.some((f) => f.status !== "ready" || !f.read),
    amounts: [[`${at}.fedimint.balance`, fedimint.balance], ...fedimint.federations.map((f, i) => [`${at}.fedimint.federations[${i}].balance`, f.balance] as [string, unknown]), ...waits("fedimint")],
  });
  if (spark?.configured) list.push({ id: `spark:${network}`, type: "spark", network, at: `${at}.spark`, route: "moves", breez: true, unreadable: unread(spark), amounts: [[`${at}.spark.balance`, spark.balance], ...waits("spark")] });
  if (usdt?.configured) list.push({ id: `usdt:${network}`, type: "usdt", network, at: `${at}.usdt`, route: "home", unreadable: unread(usdt), amounts: [[`${at}.usdt.balance`, usdt.balance], [`${at}.usdt.gasBalance`, usdt.gasBalance], ...waits("usdt")] });
  const cards = net.lightnings ?? (net.lightning ? [{ ...net.lightning, card: net.lightning.providerId === CASHU_MINT_SOURCE || !net.lightning.providerId ? "cashu" : "main" }] : []);
  for (const [i, source] of cards.entries()) {
    const where = net.lightnings ? `${at}.lightnings[${i}]` : `${at}.lightning`;
    const providerId = source.providerId ?? "";
    if (!providerId) continue;
    // The pin is enforced only by the Desktop's own transport: on the web the certificate is checked and then ignored.
    const pinned = providerId === "lnd" && pinnedCards.has(`lightning:${network}:${source.card}`) && taker?.kind !== "desktop";
    const route: Candidate["route"] = providerId === "webln" ? "none" : providerId === "fedimint" ? "home" : providerId === "breez" ? "moves"
      : providerId === "lnd" ? (pinned ? "home" : "moves") : LIGHTNING_MOVES.has(providerId) ? "moves" : "unknown";
    // The Cashu mints as a Lightning source hold nothing of their own: their money is the mints' ecash, counted there.
    const mints = providerId === CASHU_MINT_SOURCE;
    list.push({
      id: `lightning:${network}:${source.card}`, type: "lightning", network, card: source.card, at: where, route, ...(providerId === "breez" ? { breez: true as const } : {}),
      unreadable: !mints && (source.status === "connecting" || source.status === "error" || (source.status === "ready" && !source.read)),
      amounts: mints ? [] : [[`${where}.balance`, source.balance], ...waits("lightning", source.card)],
    });
  }
  if (bitcoin?.providerId) {
    const route: Candidate["route"] = ONCHAIN_MOVES.has(bitcoin.providerId) ? "moves" : bitcoin.providerId === "bitcoind" ? "home" : "unknown";
    list.push({
      id: `bitcoin:${network}`, type: "bitcoin", network, at: `${at}.bitcoin`, route,
      unreadable: bitcoin.status === "connecting" || bitcoin.status === "error" || (bitcoin.status === "ready" && !bitcoin.read),
      amounts: [[`${at}.bitcoin.balance`, bitcoin.balance], [`${at}.bitcoin.unconfirmed`, bitcoin.unconfirmed], ...waits("bitcoin")],
    });
  }
  return list;
}

/** The order in which refusals are told: what this build cannot judge first, a payment still going through last. */
const ORDER: WalletHandoffProblem[] = ["wallet", "loading", "mainnet", "expiry", "payment"];

/**
 * What each wallet of the profile does in a handoff to `facts.taker`, and why the profile cannot move now, if it
 * cannot. A plan with a refusal moves nothing.
 */
export function planHandoffWallets(facts: HandoffWalletFacts): HandoffWalletPlan {
  const { view, ownKey, taker, homes, now } = facts;
  const refusals: WalletHandoffRefusal[] = [];
  const refuse = (refusal: WalletHandoffRefusal) => refusals.push(refusal);
  if (!facts.read) return { refusal: { why: "loading", at: "not read yet" }, wallets: [] };
  if (facts.executing) refuse({ why: "payment", at: "a payment is going through" });

  const unknownKind = (view.wallets ?? []).find((wallet) => !(WALLET_TYPES as readonly string[]).includes(wallet.type));
  if (unknownKind) refuse({ why: "wallet", at: "wallets: a kind this build does not know" });
  const networks: [WalletNetwork, NetworkWalletsView, string][] = view.networks
    ? Object.entries(view.networks).map(([name, inner]) => [name as WalletNetwork, inner, `networks.${name}`])
    : [["mainnet", view, "view"]];
  for (const [name, inner, at] of networks) {
    if (name !== "mainnet" && name !== "testnet") refuse({ why: "wallet", at: `${at}: a network this build does not know` });
    const unnamed = Object.keys(inner).find((key) => !(key in NETWORK_FIELDS));
    if (unnamed) refuse({ why: "wallet", at: `${at}.${unnamed}: a field this build does not know` });
  }
  // Anywhere else in the view, an amount is money this plan does not know where it lives.
  const rest = Object.fromEntries(Object.entries(view).filter(([key]) => !VIEW_FIELDS.has(key)));
  const elsewhere = anyAmount(rest, "view");
  if (elsewhere) refuse({ why: "wallet", at: elsewhere });

  // The pins that differ between the two devices: those wallets stay home in this handoff.
  const differs = (type: WalletType) => {
    const pin = PIN_OF[type];
    return !!pin && !!taker?.pins && facts.ownPins[pin] !== undefined && facts.ownPins[pin] !== taker.pins[pin];
  };

  const wallets: PlannedWallet[] = [];
  for (const [network, inner] of networks) {
    if (network !== "mainnet" && network !== "testnet") continue;
    for (const c of candidates(inner, network, networks.find(([n]) => n === network)![2], taker, facts.pinned ?? new Set())) {
      const base = { id: c.id, type: c.type, network: c.network, ...(c.card !== undefined ? { card: c.card } : {}) };
      const mark = homes[c.id];
      const about = { wallet: c.type, network: c.network };
      if (c.route === "unknown") { refuse({ why: "wallet", at: `${c.at}: a source this build does not know`, ...about }); continue; }
      // At home on another device: never read here, and stays there, whatever its kind does now. Only its carried
      // expiry is looked at: away from home, the coins there are not renewed.
      if (mark && mark.key !== ownKey) {
        if (mark.expiresAt !== undefined && taker && taker.key !== mark.key && mark.expiresAt - now < EXPIRY_REFUSE_MS) refuse({ why: "expiry", at: c.at, ...about, expiresAt: mark.expiresAt });
        wallets.push({ ...base, route: "home", home: mark });
        continue;
      }
      const breezHome = c.type === "lightning" && c.breez && differs("spark");
      const route: WalletRoute = c.route === "moves" && (differs(c.type) || breezHome) ? "home" : c.route;
      if (route === "none") { wallets.push({ ...base, route }); continue; }
      const holding = held(c.amounts);
      if (route === "home") {
        const home: WalletHome = { key: ownKey };
        // Coins that expire, kept here: what the wallet holds and when its coins expire must be read first (a wallet
        // not open yet says 0 for coins it never read, and its mark would carry no expiry to check later).
        if ((c.type === "arkade" || c.type === "bark") && c.unreadable) { refuse({ why: "loading", at: c.at, ...about }); continue; }
        if ((c.type === "arkade" || c.type === "bark") && holding) {
          const expiresAt = coinsExpireAt(c.type, inner, now);
          if (expiresAt !== undefined) {
            home.expiresAt = expiresAt;
            if (taker?.key !== ownKey && expiresAt - now < EXPIRY_REFUSE_MS) refuse({ why: "expiry", at: c.at, ...about, expiresAt });
          }
        }
        wallets.push({ ...base, route, home });
        continue;
      }
      // Moves: read now, and on Mainnet empty unless its type may move Mainnet money.
      if (c.unreadable) { refuse({ why: "loading", at: c.at, ...about }); continue; }
      if (network === "mainnet" && !MAINNET_MOVES.has(c.type) && holding) refuse({ why: "mainnet", at: holding, ...about });
      wallets.push({ ...base, route, ...(c.breez ? { breez: true as const } : {}) });
    }
  }

  // Payments: one not approved yet is cancelled at quiesce (and must be gone after it); one at rest moves as it is and
  // is only looked up on the new device, except Mainnet money of a type that does not move there yet.
  for (const [i, intent] of (view.intents ?? []).entries()) {
    const review = intent as PaymentReview;
    if (!["pending", "submitted", "unknown"].includes(review.state)) continue;
    if (review.state === "pending") { if (facts.final) refuse({ why: "payment", at: `intents[${i}]: not approved, not cancelled` }); continue; }
    const type = review.method as WalletType;
    if (!(WALLET_TYPES as readonly string[]).includes(type)) { refuse({ why: "wallet", at: `intents[${i}]: a method this build does not know` }); continue; }
    const network = walletNetworkOf(review.network);
    const moving = wallets.some((w) => w.type === type && w.network === network && w.route === "moves");
    const staying = wallets.some((w) => w.type === type && w.network === network && w.route === "home");
    if (network === "mainnet" && !MAINNET_MOVES.has(type) && (moving || !staying)) refuse({ why: "mainnet", at: `intents[${i}]`, wallet: type, network });
  }

  const refusal = ORDER.map((why) => refusals.find((r) => r.why === why)).find((r): r is WalletHandoffRefusal => !!r) ?? null;
  return { refusal, wallets };
}

/**
 * The view as it was before the engine stopped, with what the stop cannot have changed taken from it: an SDK wallet
 * closed by the stop reads as locked, though what it holds is where it was. What lives in the profile's own database
 * (ecash, quotes, what Cashu awaits, payment attempts) is taken from the view read after the stop, where anything that
 * arrived in between shows.
 */
export function afterStop(before: WalletView, after: WalletView): WalletView {
  const sdk = (b: NetworkWalletsView | undefined, a: NetworkWalletsView): NetworkWalletsView => {
    if (!b) return a;
    const { ark, bark, fedimint, spark, usdt, lightning, lightnings, bitcoin } = b;
    // Each SDK wallet's own entries of `awaiting` as before (its view closed); Cashu's as now.
    const awaiting = [...(a.awaiting ?? []).filter((item) => item.type === "cashu" || (item.type === "lightning" && cashuCard(a, item.card))), ...(b.awaiting ?? []).filter((item) => item.type !== "cashu" && !(item.type === "lightning" && cashuCard(b, item.card)))];
    return { ...a, ark, bark, fedimint, spark, usdt, lightning, lightnings, bitcoin, awaiting };
  };
  const networks = after.networks ? Object.fromEntries(Object.entries(after.networks).map(([name, a]) => [name, sdk(before.networks?.[name as WalletNetwork], a)])) as WalletView["networks"] : undefined;
  return { ...sdk(before, after), ...(networks ? { networks } : {}), wallets: before.wallets ?? after.wallets, intents: after.intents };
}

const cashuCard = (net: NetworkWalletsView, card: string | undefined) => (net.lightnings ?? []).some((c) => c.card === card && c.providerId === CASHU_MINT_SOURCE);
