"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useCalm } from "@/lib/useCalm";

/**
 * A deck of the app's cards on the home page, with what the site adds around it: the chosen card's details in the
 * panel under the deck, and the deck dealing the next card by itself until the reader touches it. The wallet's
 * payment cards (WalletDeck.tsx) and the identity proofs (IdentityDeck.tsx) are two of these: each brings its deck
 * (the app's deck/Deck.tsx, with its own faces) and its words.
 */

/** One card's words: its name and status (for the page without JavaScript), what it does, and how ready it is. */
export type DeckItem = { id: string; name: string; status: string; body: string; limits: string };

/** The deck deals the next card this often, while nobody is pointing at it or touching it. */
const PERIOD = 3800;

const noop = () => () => {};
/** True once the page runs in the browser: the deck picks its stack or its track from the pointer, which the server cannot know. */
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

function Details({ item, tone, ...rest }: { item: DeckItem; tone: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`sp-desc ${tone}`} {...rest}>
      <p className="body">{item.body}</p>
      <p className="note">{item.limits}</p>
    </div>
  );
}

export function HomeDeck({
  anchor,
  items,
  tone,
  panel,
  deck,
}: {
  /** The id the page links to. */
  anchor: string;
  /** The cards' words, in the deck's order. */
  items: DeckItem[];
  /** The class that gives a card its colour (`--card-rgb`): the panel and the band wear the chosen card's. */
  tone: (id: string) => string;
  /** The panel under the deck, and each card's tab id (the deck's `panel`). */
  panel: { id: string; tabId: (id: string) => string };
  /** The deck itself, on the chosen card. `onSelect` is for the deck's own picks (the pointer, a swipe, a key, an arrow). */
  deck: (props: { selected: string; onSelect: (id: string) => void }) => ReactNode;
}) {
  const [selected, setSelected] = useState(items[0].id);
  const item = items.find((c) => c.id === selected) ?? items[0];
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
    const timer = setTimeout(() => setSelected(items[(items.findIndex((c) => c.id === selected) + 1) % items.length].id), PERIOD);
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
    <div className={`sp-deck ${tone(selected)}`} id={anchor}>
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
          deck({
            selected,
            // The deck says so only for its own picks, never for the site's dealing.
            onSelect: (id) => {
              setSelected(id);
              stop();
            },
          })
        ) : (
          <div className="sp-deck-placeholder" aria-hidden="true" />
        )}
      </div>
      <div className="sp-desc-stack">
        {/* Every card's details, invisible, so the panel is as tall as the longest and nothing below jumps. */}
        <div className="sp-desc-sizer" aria-hidden="true">
          {items.map((c) => (
            <Details key={c.id} item={c} tone={tone(c.id)} />
          ))}
        </div>
        <Details
          item={item}
          tone={tone(item.id)}
          id={panel.id}
          role="tabpanel"
          aria-labelledby={panel.tabId(item.id)}
          // Announce the reader's own choices, not the deck's dealing.
          aria-live={stopped ? "polite" : "off"}
        />
      </div>
      {/* Without JavaScript every card is still described. */}
      <noscript>
        <ul className="sp-noscript">
          {items.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> ({c.status}): {c.body} {c.limits}
            </li>
          ))}
        </ul>
      </noscript>
    </div>
  );
}
