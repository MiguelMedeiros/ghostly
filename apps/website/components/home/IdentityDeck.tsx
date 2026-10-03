"use client";

import { Deck } from "@/components/app/deck/Deck";
import { PROVIDER_ICONS } from "@/components/app/identities/providerMarks";
import "@/components/app/wallet-deck.css";
import type { HomeCopy } from "@/content/home";
import { HomeDeck } from "./HomeDeck";

/**
 * The identity proofs the app offers, as a deck of cards like the wallet's: the app's own deck (deck/Deck.tsx) and the
 * wallet card's face (wallet-deck.css), wearing each provider's mark from the app (identities/providerMarks.tsx, copied
 * by scripts/sync-app-deck.mjs) and its ink (app/space.css, the app's identities/id-deck.css inks).
 */

/** A card of the deck: the content's words, and its status, read from its WISP's header (SpaceSection.tsx). */
export type IdentityCard = HomeCopy["identities"]["cards"][number] & { status: string };

const GHOST = (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z" />
    <circle cx="9" cy="9" r="1.5" fill="var(--ghost-eye)" />
    <circle cx="15" cy="9" r="1.5" fill="var(--ghost-eye)" />
  </svg>
);

const tone = (id: string) => `identity-ink-${id}`;
const PANEL = { id: "identity-panel", tabId: (id: string) => `identity-tab-${id}` };
const Mark = ({ id }: { id: string }) => PROVIDER_ICONS[id]?.mark(26) ?? null;

/** The wallet card's face (WalletCardDeck.tsx's WalletCardFace), with the provider's mark: its name, what it proves with, and its status. */
function IdentityCardFace({ card, after }: { card: IdentityCard; after: boolean }) {
  return (
    <span className="wallet-deck-face" data-deck="face" data-after={after || undefined}>
      <span className="wallet-deck-card-glyph" aria-hidden="true">
        <Mark id={card.id} />
      </span>
      <span className="wallet-deck-card-status">{card.status}</span>
      {/* A card after the chosen one shows only its trailing edge: its mark is there too. */}
      <span className="wallet-deck-card-glyph-end" aria-hidden="true">
        <Mark id={card.id} />
      </span>
      <span className="wallet-deck-card-ghost" data-deck="ghost" aria-hidden="true">
        {GHOST}
      </span>
      <span className="wallet-deck-card-text">
        <span className="wallet-deck-card-name">{card.name}</span>
        <span className="wallet-deck-card-balance">{card.kind}</span>
      </span>
      <span className="wallet-deck-card-chip" aria-hidden="true" />
      <span className="wallet-deck-card-sheen" data-deck="sheen" aria-hidden="true" />
    </span>
  );
}

export function IdentityDeck({ title, cards }: { title: string; cards: IdentityCard[] }) {
  return (
    <HomeDeck
      anchor="identities"
      items={cards}
      tone={tone}
      panel={PANEL}
      deck={({ selected, onSelect }) => (
        <Deck<IdentityCard>
          cards={cards}
          selected={selected}
          onSelect={onSelect}
          kind="tabs"
          panel={PANEL}
          label={title}
          name="identity-deck"
          className="identity-deck"
          testId={(card) => `identity-card-${card.id}`}
          face={(card, { after }) => <IdentityCardFace card={card} after={after} />}
          mark={(card) => <Mark id={card.id} />}
          tone={(card) => tone(card.id)}
        />
      )}
    />
  );
}
