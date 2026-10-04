"use client";

import { CardDeck } from "@/components/app/WalletCardDeck";
import { WALLET_RAILS, type WalletCard, type WalletRail } from "@/components/app/walletCardTypes";
import type { HomeCopy } from "@/content/home";
import { HomeDeck } from "./HomeDeck";

/**
 * The wallet's cards, as the app shows them: this is the app's own deck (components/app, copied from the app's
 * apps/ui/src/components by scripts/sync-app-deck.mjs), with its hover stack, its swipe track on a touch screen, its keys and
 * its motion. What the site adds (HomeDeck.tsx): the cards' words come from content/home.ts, the chosen card's details
 * sit in the panel under the deck, and the deck deals the next card by itself until the reader touches it.
 */

type Copy = HomeCopy["wallets"]["cards"][number];

/** The content's ids that differ from the app's. */
const RAIL: Record<string, WalletRail> = { ark: "arkade", onchain: "bitcoin" };
const railOf = (c: Copy) => RAIL[c.id] ?? (c.id as WalletRail);

export function WalletDeck({ t }: { t: HomeCopy["wallets"] }) {
  // The app's order, whatever order the content lists them in.
  const copies = [...t.cards].sort((a, b) => WALLET_RAILS.indexOf(railOf(a)) - WALLET_RAILS.indexOf(railOf(b)));
  // A card's face, as the app's wallet page draws it: the name, what kind of payment it is where the app shows the
  // balance, and the network it runs on where the app shows its status.
  const cards: WalletCard[] = copies.map((c) => ({
    id: railOf(c),
    name: c.name,
    balance: c.kind,
    detail: "",
    status: c.network,
    ready: c.net !== "test",
  }));
  return (
    <HomeDeck
      anchor="wallets"
      items={copies.map((c) => ({ id: railOf(c), name: c.name, status: c.network, body: c.body, limits: c.limits }))}
      tone={(rail) => `wallet-card-${rail}`}
      panel={{ id: "wallet-panel", tabId: (rail) => `wallet-tab-${rail}` }}
      deck={({ selected, onSelect }) => (
        <CardDeck
          cards={cards}
          selected={selected as WalletRail}
          onSelect={onSelect}
          kind="tabs"
          label={t.title}
          name="wallet-deck"
          testId={(rail) => `wallet-card-${rail}`}
        />
      )}
    />
  );
}
