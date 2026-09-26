import { formatPaymentAmount, walletNetworkOf, type PaymentReview, type WalletNetwork } from "@ghostly/core";
import type { NetworkWalletsView, WalletType } from "./types";

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
  /** It comes with another wallet and goes with it (Lightning through the Cashu mints). */
  comesWith?: WalletType;
}

const UNFINISHED = new Set(["pending", "submitted", "unknown"]);
const sats = (n: number, network: WalletNetwork) => `${n.toLocaleString("en-US")} ${network === "testnet" ? "test sats" : "sats"}`;
const known = (amount: number, network: WalletNetwork) => ({ empty: amount <= 0, text: sats(Math.max(0, amount), network) });
/** A self-custodial source keeps its recovery phrase sealed with it (Breez, a BDK wallet): the money is on this device. */
const phraseHeld = (secrets: string[] | undefined) => !!secrets?.includes("mnemonic");

/** The parts of a network's view a removal reads. */
export type RemovalView = Partial<Pick<NetworkWalletsView, "balance" | "lightning" | "bitcoin" | "ark" | "bark" | "spark" | "fedimint" | "usdt">>;

/** What removing the `type` wallet of `network` takes away. `intents`: the profile's payments (the wallet view's `intents`). */
export function walletRemoval(type: WalletType, network: WalletNetwork, view: RemovalView | undefined, intents: readonly PaymentReview[] = []): WalletRemoval {
  const base = { type, network };
  const pending = intents.filter((i) => i.method === type && UNFINISHED.has(i.state) && walletNetworkOf(i.network) === network).length;
  switch (type) {
    case "cashu": return { ...base, custody: "device", held: known(view?.balance ?? 0, network), backup: "tokens", pending };
    case "lightning": {
      const ln = view?.lightning;
      if (!ln?.providerId || ln.providerId === "cashu-mint") return { ...base, custody: "elsewhere", held: known(0, network), backup: "none", pending: 0, comesWith: "cashu" };
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

/** Removing it may lose money: what it holds is on this device, and is not nothing (or could not be read). */
export const removalRisksFunds = (r: WalletRemoval) => r.custody === "device" && (r.held === "unknown" || !r.held.empty);
