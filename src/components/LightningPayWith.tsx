import { useState } from "react";
import type { WalletPlatform } from "../lib/platform";
import { Select } from "./ui/Select";
import { lightningPayers } from "./walletCardData";

/**
 * Which Lightning card pays, on a network with several: the first eligible one (ready, and holding enough when it
 * says) until the person picks another. `payer` is the wallet bound to it; with one card or none, the network's own.
 */
export function useLightningPayer(wallet: WalletPlatform | undefined, amount?: number) {
  return lightningPayer(wallet, amount, useState(""));
}
/** The same, for a component that knows its wallet only after an early return: the choice is kept by its caller. */
export function lightningPayer(wallet: WalletPlatform | undefined, amount: number | undefined, [chosen, choose]: [string, (card: string) => void]) {
  const { cards, first } = lightningPayers(wallet?.getState(), amount);
  const card = cards.length > 1 ? (cards.some((c) => c.card === chosen) ? chosen : first) : undefined;
  return { payer: wallet && card ? wallet.forLightning(card) : wallet, card, cards, choose };
}

/** "Pay with": the Lightning cards that can pay, each with its balance. Shown only when there is a choice. */
export function LightningPayWith({ payer, unit, disabled, testId }: { payer: ReturnType<typeof useLightningPayer>; unit: string; disabled?: boolean; testId: string }) {
  if (!payer.card) return null;
  return (
    <label className="block space-y-1 text-xs">Pay with
      <Select size="sm" aria-label="Lightning card" data-testid={testId} value={payer.card} disabled={disabled} onChange={payer.choose}
        options={payer.cards.map((c) => ({ value: c.card, label: c.name, description: c.balance !== undefined ? `${c.balance.toLocaleString()} ${unit}` : undefined }))} />
    </label>
  );
}
