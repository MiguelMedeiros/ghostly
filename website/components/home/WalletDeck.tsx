"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CardDeck } from "@/components/app/WalletCardDeck";
import { WALLET_RAILS, type WalletCard, type WalletRail } from "@/components/app/walletCardTypes";
import { LevelBadge } from "@/components/site/Level";
import type { Locale } from "@/lib/i18n";
import { useCalm } from "@/lib/useCalm";
import { shell } from "@/content/shell";
import type { HomeCopy } from "@/content/home";

/**
 * The wallet's cards, as the app shows them: this is the app's own deck (components/app, copied from the app's
 * src/components by scripts/sync-app-deck.mjs), with its hover stack, its swipe track on a touch screen, its keys and
 * its motion. What the site adds: the cards' words come from content/home.ts, the chosen card's details sit in the
 * panel under the deck, and the deck deals the next card by itself until the reader touches it.
 */

type Copy = HomeCopy["wallets"]["cards"][number];

/** The content's ids that differ from the app's. */
const RAIL: Record<string, WalletRail> = { ark: "arkade", onchain: "bitcoin" };
const railOf = (c: Copy) => RAIL[c.id] ?? (c.id as WalletRail);

/** The deck deals the next card this often, while nobody is pointing at it or touching it. */
const PERIOD = 3800;

const noop = () => () => {};
/** True once the page runs in the browser: the deck picks its stack or its track from the pointer, which the server cannot know. */
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

function Details({ card, locale, ...rest }: { card: Copy; locale: Locale } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`sp-desc wallet-card-${railOf(card)}`} {...rest}>
      <p className="body">{card.body}</p>
      <p className="note">
        {"more" in card && card.more && <LevelBadge level={card.more} locale={locale} small />} {card.limits}
      </p>
    </div>
  );
}

export function WalletDeck({ t, locale }: { t: HomeCopy["wallets"]; locale: Locale }) {
  const levels = shell[locale].levels;
  // The app's order, whatever order the content lists them in.
  const copies = [...t.cards].sort((a, b) => WALLET_RAILS.indexOf(railOf(a)) - WALLET_RAILS.indexOf(railOf(b)));
  // A card's face, as the app's wallet page draws it: the name, what kind of payment it is where the app shows the
  // balance, and how ready it is where the app shows its status.
  const cards: WalletCard[] = copies.map((c) => ({
    id: railOf(c),
    name: c.name,
    balance: c.kind,
    detail: "",
    status: levels[c.level],
    ready: c.level === "released",
  }));
  const [selected, setSelected] = useState<WalletRail>(cards[0].id);
  const copy = copies[Math.max(0, cards.findIndex((c) => c.id === selected))];
  const mounted = useMounted();
  const calm = useCalm();

  // Why the deck is not dealing now, one flag per reason. `stopped` is for good: the reader chose a card, or touched,
  // clicked or typed in the deck. Pointing at it or focusing it only holds it.
  const zone = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const running = mounted && inView && visible && !calm && !stopped && !hovered && !focused;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setSelected(cards[(cards.findIndex((c) => c.id === selected) + 1) % cards.length].id), PERIOD);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, selected]);

  // Deal only while most of the deck is on screen, in a visible tab.
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting && e.intersectionRatio >= 0.5), { threshold: [0.5] });
    io.observe(el);
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mounted]);

  const stop = () => setStopped(true);

  return (
    <div className={`sp-wallet wallet-card-${selected}`} id="wallets">
      <div
        ref={zone}
        className="sp-deck-zone"
        onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={stop}
        onTouchStart={stop}
        onKeyDown={stop}
        // A keyboard reader in the deck holds it; a click leaves the focus on a card too, but it has stopped the deck already.
        onFocus={(e) => setFocused((e.target as HTMLElement).matches(":focus-visible"))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        {mounted ? (
          <CardDeck
            cards={cards}
            selected={selected}
            // The deck says so only for its own picks (the pointer, a swipe, a key, an arrow), never for the site's dealing.
            onSelect={(rail) => {
              setSelected(rail);
              stop();
            }}
            kind="tabs"
            label={t.title}
            name="wallet-deck"
            testId={(rail) => `wallet-card-${rail}`}
          />
        ) : (
          <div className="sp-deck-placeholder" aria-hidden="true" />
        )}
      </div>
      <div className="sp-desc-stack">
        {/* Every card's details, invisible, so the panel is as tall as the longest and nothing below jumps. */}
        <div className="sp-desc-sizer" aria-hidden="true">
          {copies.map((c) => (
            <Details key={c.id} card={c} locale={locale} />
          ))}
        </div>
        <Details
          card={copy}
          locale={locale}
          id="wallet-panel"
          role="tabpanel"
          aria-labelledby={`wallet-tab-${selected}`}
          // Announce the reader's own choices, not the deck's dealing.
          aria-live={stopped ? "polite" : "off"}
        />
      </div>
      {/* Without JavaScript every card is still described. */}
      <noscript>
        <ul className="sp-noscript">
          {copies.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> ({levels[c.level]}): {c.body} {c.limits}
            </li>
          ))}
        </ul>
      </noscript>
    </div>
  );
}
