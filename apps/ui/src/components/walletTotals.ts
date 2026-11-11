import type { Translate } from "../contexts/I18nContext";
import type { WalletNetwork, WalletState } from "../lib/platform";
import { CASHU_MINT_SOURCE, deckId, networkState, type InstanceCard } from "./walletCardData";
import type { WalletRail } from "./walletCardTypes";

/**
 * Where a card's part of a total stands. `counted`: its amount is in the total. `shared`: it spends another card's
 * balance (Lightning through the Cashu mints spends Cashu's; a Breez Lightning card on the Spark wallet's own phrase
 * is that Spark wallet), so it is not counted again. `unknown`: its balance could not be read now (an error, a source
 * still connecting, a balance not read yet, a locked wallet): never counted as 0, it stays out of the total. `away`: at
 * home on another device. `none`: not set up, it holds nothing.
 */
export type TotalState = "counted" | "shared" | "unknown" | "away" | "none";

/**
 * What a counted row says beside its amount: `unconfirmed` on-chain sats, sats `waiting` in a wallet that is not
 * spendable yet (an Ark deposit on its way in, a Bark round), ecash backed by a `mint` or a `federation`.
 */
export type TotalNote = "unconfirmed" | "waiting" | "mint" | "federation";

export interface TotalRow<A> {
  /** The card's deck id (`bitcoin:testnet`). */
  id: string;
  rail: WalletRail;
  /** The card's name, as its face says it. */
  name: string;
  state: TotalState;
  /** `counted` and `shared`: what it holds, in sats (USDT: the token's base units). */
  amount?: A;
  /** Part of `amount` that cannot be spent yet: in the total, not in what is ready. */
  pending?: A;
  note?: TotalNote;
  /** `shared`: the card whose balance it spends. */
  sharedWith?: string;
  /** `away`: the device it is at home on ("" when this device does not know its name). */
  device?: string;
}

export interface BitcoinTotal {
  network: WalletNetwork;
  /** Sats: every counted card, pending ones included. */
  total: number;
  /** Sats that can be spent now: the total minus what is pending (unconfirmed, waiting). */
  ready: number;
  rows: TotalRow<number>[];
  /** Cards whose balance is not in the total because it is not known here (unknown, away). */
  uncounted: number;
}

export interface UsdtTotal {
  network: WalletNetwork;
  /** In the token's base units, exact. */
  total: bigint;
  decimals: number;
  /** A test token (Testnet, or any chain but Ethereum's): TEST-USDT. */
  test: boolean;
  rows: TotalRow<bigint>[];
  uncounted: number;
}

export interface WalletTotals {
  /** Absent when the network has no Bitcoin card (Lightning, on-chain, Cashu, Fedimint, Spark, Ark, Bark). */
  bitcoin?: BitcoinTotal;
  /** Absent when the network has no USDT card. */
  usdt?: UsdtTotal;
}

type Part<A> = Pick<TotalRow<A>, "state" | "amount" | "pending" | "note" | "sharedWith">;

/**
 * One balance per currency on one network, from the wallets the page already has: `cards` are the deck's
 * (`walletCards`), whose ids, names and order the rows keep; only `network`'s count. Testnet and Mainnet are never
 * summed together. A card whose balance is not known is a row with no amount, and the total leaves it out.
 */
export function walletTotals(state: WalletState, network: WalletNetwork, cards: InstanceCard[]): WalletTotals {
  const shown = cards.filter((c) => c.network === network);
  const instances = (state.wallets ?? []).filter((w) => w.network === network);
  const instanceOf = (card: InstanceCard) => instances.find((w) => deckId(w, state) === card.id);
  const cashuCard = shown.find((c) => c.rail === "cashu");
  const sparkCard = shown.find((c) => c.rail === "spark");
  // Whether the network's Spark wallet's balance is read: a Breez Lightning card that is that wallet is counted there.
  const sparkCounted = !!sparkCard && bitcoinPart("spark", networkState(state, network)).state === "counted";
  const bitcoin: TotalRow<number>[] = [], usdt: TotalRow<bigint>[] = [];
  let decimals: number | undefined, test = network === "testnet";
  for (const card of shown) {
    const home = instanceOf(card)?.home;
    const base = { id: card.id, rail: card.rail, name: card.name };
    if (card.rail === "usdt") {
      const s = networkState(state, network);
      if (s.usdt?.decimals !== undefined) decimals = s.usdt.decimals;
      if (s.usdt?.chainId && s.usdt.chainId !== 1) test = true;
      usdt.push(home ? { ...base, state: "away", device: home.device } : { ...base, ...usdtPart(s) });
      continue;
    }
    if (home) { bitcoin.push({ ...base, state: "away", device: home.device }); continue; }
    const s = networkState(state, network, card.card);
    const part = bitcoinPart(card.rail, s);
    if (card.rail === "lightning" && viaMints(s)) {
      // Lightning through the mints spends the Cashu balance: counted once, on the Cashu card when there is one.
      bitcoin.push(cashuCard && part.state === "counted" ? { ...base, ...part, state: "shared", sharedWith: cashuCard.name, note: undefined } : { ...base, ...part });
      continue;
    }
    // The engine says which card is the Spark wallet (the same Breez database), never the two amounts: read at
    // different moments they differ, and another wallet may hold the same.
    if (card.rail === "lightning" && s.lightning?.sameWalletAs === "spark" && sparkCard && sparkCounted && part.state === "counted") {
      bitcoin.push({ ...base, ...part, state: "shared", sharedWith: sparkCard.name });
      continue;
    }
    bitcoin.push({ ...base, ...part });
  }
  const out: WalletTotals = {};
  if (bitcoin.length) {
    const counted = bitcoin.filter((r) => r.state === "counted");
    const total = counted.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const pending = counted.reduce((sum, r) => sum + (r.pending ?? 0), 0);
    out.bitcoin = { network, total, ready: total - pending, rows: bitcoin, uncounted: bitcoin.filter(uncounted).length };
  }
  if (usdt.length) {
    const total = usdt.filter((r) => r.state === "counted").reduce((sum, r) => sum + (r.amount ?? 0n), 0n);
    out.usdt = { network, total, decimals: decimals ?? 6, test, rows: usdt, uncounted: usdt.filter(uncounted).length };
  }
  return out;
}

/**
 * The deck's cards with a shared balance said in words: a card that spends another card's balance (`shared` in the
 * totals) says "Uses your Cashu balance" where its amount was, so the number shows on one card only and the deck
 * never reads as twice what there is. Ids and order stay; only `network`'s cards are looked at.
 */
export function sharedBalanceCards<C extends InstanceCard>(state: WalletState, network: WalletNetwork, cards: C[], t: Translate): C[] {
  const shared = sharedSources(state, network, cards);
  return shared.size ? cards.map((c) => shared.has(c.id) ? { ...c, balance: t("wallet.cards.balance.shared", { name: shared.get(c.id)! }) } : c) : cards;
}

/** `network`'s cards that spend another card's balance, by id, with that card's name (`Cashu`, `Spark`). */
export const sharedSources = (state: WalletState, network: WalletNetwork, cards: InstanceCard[]): Map<string, string> =>
  new Map((walletTotals(state, network, cards).bitcoin?.rows ?? []).filter((r) => r.state === "shared").map((r) => [r.id, r.sharedWith ?? ""]));

const uncounted = (row: TotalRow<unknown>) => row.state === "unknown" || row.state === "away";

/** Lightning through the network's Cashu mints (the default source): its balance is Cashu's. */
const viaMints = (s: WalletState) => !s.lightning?.providerId || s.lightning.providerId === CASHU_MINT_SOURCE;

const counted = (amount: number, pending = 0, note?: TotalNote): Part<number> => {
  const waiting = Math.max(0, pending);
  return { state: "counted", amount: Math.max(0, amount) + waiting, ...(waiting ? { pending: waiting } : {}), ...(note ? { note } : waiting ? { note: "waiting" as const } : {}) };
};
const UNKNOWN: Part<never> = { state: "unknown" };
const NONE: Part<never> = { state: "none" };

/**
 * What one Bitcoin card holds, from its network's state (`networkState`, with the card's own Lightning). Known only
 * when its wallet says it read it: every view carries that (`read`), and a balance before it says nothing.
 */
export function bitcoinPart(rail: Exclude<WalletRail, "usdt">, s: WalletState): Part<number> {
  switch (rail) {
    // Ecash is kept on this device: its balance is always known once there is a mint.
    case "cashu": return s.mints.length ? counted(s.balance, 0, "mint") : NONE;
    case "lightning": {
      const ln = s.lightning;
      if (!ln || viaMints(s)) return s.mints.length ? counted(s.balance, 0, "mint") : NONE;
      return source(ln);
    }
    case "bitcoin": {
      const bt = s.bitcoin;
      if (!bt || bt.status === "none") return NONE;
      const part = source(bt);
      return part.state === "counted" && bt.unconfirmed ? counted(bt.balance ?? 0, bt.unconfirmed, "unconfirmed") : part;
    }
    case "arkade": {
      const ark = s.ark;
      if (!ark?.configured) return NONE;
      return !ark.locked && ark.read ? counted(ark.balance, ark.incoming) : UNKNOWN;
    }
    case "bark": {
      const bark = s.bark;
      if (!bark?.configured) return NONE;
      return !bark.locked && bark.read ? counted(bark.balance, bark.pending) : UNKNOWN;
    }
    case "spark": {
      const spark = s.spark;
      if (!spark?.configured) return NONE;
      return !spark.locked && spark.read ? counted(spark.balance) : UNKNOWN;
    }
    case "fedimint": {
      const federations = s.fedimint?.federations ?? [];
      if (!federations.length) return NONE;
      // Every federation read, or the card's balance is not known: one that did not answer could hold the most.
      return federations.every((f) => f.read && f.status === "ready") ? counted(federations.reduce((sum, f) => sum + f.balance, 0), 0, "federation") : UNKNOWN;
    }
  }
}

/**
 * A Lightning or on-chain source's balance: read, connected and fresh. Reconnecting shows the last one read
 * (`balanceAt`), and a read that failed leaves the last one with an error: neither is a balance now.
 */
function source(view: NonNullable<WalletState["bitcoin"]> | NonNullable<WalletState["lightning"]>): Part<number> {
  if (view.status === "none") return NONE;
  if (view.status !== "ready" || !view.read || view.balance === undefined || view.balanceAt !== undefined || view.error) return UNKNOWN;
  return counted(view.balance);
}

function usdtPart(s: WalletState): Part<bigint> {
  const usdt = s.usdt;
  if (!usdt?.configured) return NONE;
  if (usdt.locked || !usdt.read) return UNKNOWN;
  try { return { state: "counted", amount: BigInt(usdt.balance) }; } catch { return UNKNOWN; }
}

