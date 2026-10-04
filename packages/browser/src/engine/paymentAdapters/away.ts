import { engineText } from "@ghostly/core";

/*
 * Wallets at home on another device (WISP 06 § Wallets that stay home): their database lives there, and no other
 * device opens them. The engine says which, by wallet id (`<type>:<network>`, `lightning:<network>:<card>`), before
 * any wallet opens; each wallet asks here before it opens its SDK, so no path that opens one (a start, a retry, a
 * restore, an unlock) opens a wallet that is away.
 */

let away = new Map<string, string>();

/** The wallets away from this device, by wallet id, with the name of their home device ("" when it has none here). */
export function setAwayWallets(next: ReadonlyMap<string, string>): void {
  away = new Map(next);
}

/** The home device's name of a wallet away from this device, or undefined when it is here. */
export function awayFrom(id: string): string | undefined {
  return away.get(id);
}

/** A wallet that cannot be used here: it is at home on another device. */
export class WalletAwayError extends Error {
  constructor(wallet: string, device: string) {
    super(device ? engineText("walletAway", { wallet, device }) : engineText("walletAwayUnnamed", { wallet }));
    this.name = "WalletAwayError";
  }
}

/**
 * Whether a single-writer wallet (Ark, Bark, Spark and the Breez source, Fedimint) may open its SDK now: the engine
 * says, from a good turn read under 60 seconds old (WISP 06 § Wallets). Every open asks, the retries of each wallet
 * included, so a device replaced while it was offline does not reopen one on a retry.
 */
let turnGate: () => Promise<boolean> = async () => true;
export function setSingleWriterGate(gate: (() => Promise<boolean>) | null): void {
  turnGate = gate ?? (async () => true);
}

/** Throws (the wallet tries again later, as it does when its server does not answer) without a fresh good turn read. */
export async function requireTurn(): Promise<void> {
  if (!(await turnGate().catch(() => false))) throw new Error("Checking which device is active");
}

/** Throws when the wallet `id` is at home on another device. */
export function refuseAway(id: string, wallet: string): void {
  const device = awayFrom(id);
  if (device !== undefined) throw new WalletAwayError(wallet, device);
}
