import { formatPaymentAmount, walletNetworkOf, type PaymentReview, type WalletNetwork } from "@ghostly/core";
import type { NetworkWalletsView, WalletAwaitingView, WalletType } from "./types";

/** How a wallet can be kept before it is removed: its recovery phrase (and a backup file), its ecash as tokens, or nothing Ghostly can show. */
export type WalletBackup = "phrase" | "tokens" | "none";

/**
 * What removing one wallet takes away, read from its network's view: shown before the person confirms, and checked
 * again by the engine, which refuses a removal that would lose money nobody agreed to lose.
 */
export interface WalletRemoval {
  type: WalletType;
  network: WalletNetwork;
  /**
   * Where its money is. `device`: its keys or its ecash are on this device only, so removing it loses what it holds
   * unless there is a backup. `elsewhere`: a node or a service holds the money, and removing only forgets the way there.
   */
  custody: "device" | "elsewhere";
  /** What it holds, in words ("1,250 test sats"), and whether that is nothing; `unknown`: it is not connected, so its balance could not be read. */
  held: { empty: boolean; text: string } | "unknown";
  backup: WalletBackup;
  /** Payments through it that are not finished: they must end (or be cancelled) first. */
  pending: number;
  /** A Lightning card: which one. */
  card?: string;
  /** It comes with another wallet and goes with it (Lightning through the Cashu mints, while it is the network's only card). */
  comesWith?: WalletType;
  /**
   * Money it still waits for: requests of ours only it can be paid through, its invoices, paid invoices whose ecash is
   * not claimed yet. Removing it closes the requests (the contacts are told); what is paid to any of them afterwards
   * is lost when the money would have come to this device.
   */
  awaiting: RemovalItem[];
  /** Ecash sent from it that the contact has not taken yet: if it comes back, adding its mint again takes it back. */
  returnable: RemovalItem[];
}

/** One thing a removal closes or leaves behind, in words ("A request for 50,000 sats, still open"). */
export interface RemovalItem {
  kind: WalletAwaitingView["kind"];
  text: string;
  /** Its amount alone, in words ("50,000 sats"). */
  amount: string;
  paymentId?: string;
}

const UNFINISHED = new Set(["pending", "submitted", "unknown"]);
const sats = (n: number, network: WalletNetwork) => `${n.toLocaleString("en-US")} ${network === "testnet" ? "test sats" : "sats"}`;
const known = (amount: number, network: WalletNetwork) => ({ empty: amount <= 0, text: sats(Math.max(0, amount), network) });
/** A self-custodial source keeps its recovery phrase sealed with it (Breez, a BDK wallet): the money is on this device. */
const phraseHeld = (secrets: string[] | undefined) => !!secrets?.includes("mnemonic");

/** The parts of a network's view a removal reads. */
export type RemovalView = Partial<Pick<NetworkWalletsView, "balance" | "lightning" | "lightnings" | "bitcoin" | "ark" | "bark" | "spark" | "fedimint" | "usdt" | "awaiting">>;

const ITEM: Record<WalletAwaitingView["kind"], (amount: string) => string> = {
  request: (a) => `A request for ${a} in a chat, still open`,
  invoice: (a) => `An invoice for ${a}, not paid yet`,
  paid: (a) => `${a} paid to an invoice, not claimed from the mint yet`,
  unclaimed: (a) => `${a} the mint says it issued for an invoice, never received here`,
  sent: (a) => `${a} in ecash you sent, not taken yet`,
};

function items(type: WalletType, network: WalletNetwork, view: RemovalView | undefined, card?: string) {
  const amount = (n: number) => type === "usdt"
    ? `${formatPaymentAmount(String(n), view?.usdt?.decimals ?? 6)} ${network === "testnet" ? "TEST-USDT" : "USDT"}`
    : sats(n, network);
  // Lightning through the mints is the Cashu wallet's: what it waits for is listed there.
  // A Lightning card's own: what went through it (one of several), or through none named.
  const mine = (view?.awaiting ?? []).filter((a) => a.type === type && (card === undefined || a.card === undefined || a.card === card));
  const item = (a: WalletAwaitingView): RemovalItem => ({ kind: a.kind, text: ITEM[a.kind](amount(a.amount)), amount: amount(a.amount), ...(a.paymentId ? { paymentId: a.paymentId } : {}) });
  // Cashu sent from a mint comes back once the mint is added again; Fedimint notes are taken back through the removed client only.
  const returns = (a: WalletAwaitingView) => a.kind === "sent" && type === "cashu";
  return { awaiting: mine.filter((a) => !returns(a)).map(item), returnable: mine.filter(returns).map(item) };
}

/**
 * What removing the `type` wallet of `network` takes away. `intents`: the profile's payments (the wallet view's
 * `intents`). `card`: the Lightning card (absent: the network's default for receiving).
 */
export function walletRemoval(type: WalletType, network: WalletNetwork, view: RemovalView | undefined, intents: readonly PaymentReview[] = [], card?: string): WalletRemoval {
  const lnCard = type === "lightning" ? view?.lightnings?.find((c) => (card === undefined ? c.receive : c.card === card)) : undefined;
  const base = { type, network, ...items(type, network, view, lnCard?.card ?? card), ...(lnCard ? { card: lnCard.card } : card !== undefined ? { card } : {}) };
  const pending = intents.filter((i) => i.method === type && UNFINISHED.has(i.state) && walletNetworkOf(i.network) === network).length;
  switch (type) {
    case "cashu": return { ...base, custody: "device", held: known(view?.balance ?? 0, network), backup: "tokens", pending };
    case "lightning": {
      const ln = lnCard ?? view?.lightning;
      // The mints' card holds nothing of its own (its ecash is the Cashu wallet's): it goes alone next to other cards.
      const others = (view?.lightnings ?? []).some((c) => c.card !== lnCard?.card);
      if (!ln?.providerId || ln.providerId === "cashu-mint") return { ...base, custody: "elsewhere", held: known(0, network), backup: "none", pending: 0, ...(others ? {} : { comesWith: "cashu" as const }), awaiting: [], returnable: [] };
      const device = phraseHeld(ln.secrets);
      return { ...base, custody: device ? "device" : "elsewhere", held: ln.status === "ready" && ln.balance !== undefined ? known(ln.balance, network) : device ? "unknown" : known(0, network), backup: "none", pending };
    }
    case "bitcoin": {
      const bt = view?.bitcoin, device = phraseHeld(bt?.secrets);
      const total = (bt?.balance ?? 0) + (bt?.unconfirmed ?? 0);
      return { ...base, custody: device ? "device" : "elsewhere", held: bt?.status === "ready" ? known(total, network) : device ? "unknown" : known(0, network), backup: "none", pending };
    }
    case "arkade": {
      const ark = view?.ark, open = !!ark?.configured && !ark.locked;
      return { ...base, custody: "device", held: open ? known(ark!.balance + (ark!.recoverable ?? 0) + (ark!.incoming ?? 0), network) : "unknown", backup: "phrase", pending };
    }
    case "bark": {
      const bark = view?.bark, open = !!bark?.configured && !bark.locked;
      return { ...base, custody: "device", held: open ? known(bark!.balance, network) : "unknown", backup: "phrase", pending };
    }
    case "spark": {
      const spark = view?.spark, open = !!spark?.configured && !spark.locked;
      return { ...base, custody: "device", held: open ? known(spark!.balance, network) : "unknown", backup: "phrase", pending };
    }
    case "fedimint": {
      const fm = view?.fedimint, federations = fm?.federations ?? [];
      const open = federations.every((f) => f.status === "ready");
      return { ...base, custody: "device", held: open ? known(fm?.balance ?? 0, network) : "unknown", backup: "phrase", pending };
    }
    case "usdt": {
      const usdt = view?.usdt;
      if (!usdt?.configured || usdt.locked) return { ...base, custody: "device", held: "unknown", backup: "phrase", pending };
      const token = BigInt(usdt.balance || "0"), gas = BigInt(usdt.gasBalance || "0");
      const test = network === "testnet";
      const parts = [
        ...(token > 0n || gas === 0n ? [`${formatPaymentAmount(usdt.balance || "0", usdt.decimals ?? 6)} ${test ? "TEST-USDT" : "USDT"}`] : []),
        ...(gas > 0n ? [`${formatPaymentAmount(usdt.gasBalance, 18)} ${test ? "test ETH" : "ETH"}`] : []),
      ];
      return { ...base, custody: "device", held: { empty: token === 0n && gas === 0n, text: parts.join(" and ") }, backup: "phrase", pending };
    }
  }
}

/**
 * Removing it may lose money: what it holds is on this device, and is not nothing (or could not be read), or money
 * may still come to it (an open request or invoice, a paid invoice not claimed yet).
 */
export const removalRisksFunds = (r: WalletRemoval) => r.custody === "device" && (r.held === "unknown" || !r.held.empty || r.awaiting.length > 0);
