"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LevelBadge } from "@/components/site/Level";
import type { Locale } from "@/lib/i18n";
import type { HomeCopy } from "@/content/home";

// Each method keeps the identity it has in the app's wallet.
const LOOK: Record<string, { from: string; to: string; ink: string; glyph: React.ReactNode }> = {
  cashu: {
    from: "#0f3b44",
    to: "#0b1f2a",
    ink: "#2dd4bf",
    glyph: <path d="M15.5 8.5a5 5 0 1 0 0 7M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  },
  lightning: {
    from: "#4a3510",
    to: "#1f1a0e",
    ink: "#fbbf24",
    glyph: <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" />,
  },
  ark: {
    from: "#2a2d5c",
    to: "#141630",
    ink: "#a5b4fc",
    glyph: <path d="M12 3 3 20h18zM7.5 15h9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  },
  bark: {
    from: "#173a2e",
    to: "#0c1d18",
    ink: "#6ee7b7",
    glyph: <path d="M12 3 3 20h18zM9 20c1-3 2-4.5 3-4.5s2 1.5 3 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  },
  usdt: {
    from: "#0f4034",
    to: "#0a1f1a",
    ink: "#34d399",
    glyph: <path d="M4 5h16M12 5v15M6.5 10c3.5 1.4 7.5 1.4 11 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  },
  onchain: {
    from: "#43250c",
    to: "#1d140b",
    ink: "#fb923c",
    glyph: <path d="M9 4v16M13 4v16M7 6h7.5a3 3 0 0 1 0 6H7m0 0h8.5a3 3 0 0 1 0 6H7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />,
  },
};

type Card = HomeCopy["wallets"]["cards"][number];

function Description({ card, locale, ...rest }: { card: Card; locale: Locale } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="sp-desc" {...rest}>
      <div className="sp-desc-head">
        <h4>
          {card.name} <span className="dim">· {card.kind}</span>
        </h4>
        <LevelBadge level={card.level} locale={locale} />
        {"more" in card && card.more && <LevelBadge level={card.more} locale={locale} small />}
      </div>
      <p className="body">{card.body}</p>
      <p className="note">{card.limits}</p>
    </div>
  );
}

/** On phones the deck is a horizontal snapping track; on desktop the cards fan out in place. */
const PHONE = "(max-width: 860px)";

export function WalletDeck({ t, locale }: { t: HomeCopy["wallets"]; locale: Locale }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const deck = useRef<HTMLDivElement>(null);
  const card = t.cards[active];
  const look = LOOK[card.id];

  // Only the phone track scrolls; on desktop the cards are absolutely placed and there is nothing to bring into view.
  const bringIntoView = useCallback((i: number) => {
    if (!deck.current || !window.matchMedia(PHONE).matches) return;
    tabs.current[i]?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
  }, []);

  const choose = (i: number) => {
    setActive(i);
    bringIntoView(i);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = t.cards.length;
    let next = active;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (active + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (active - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    choose(next);
    tabs.current[next]?.focus({ preventScroll: true });
  };

  // Phone: whichever card rests nearest the centre of the track is the active one.
  useEffect(() => {
    const track = deck.current;
    if (!track) return;
    const media = window.matchMedia(PHONE);
    const pick = () => {
      if (!media.matches) return;
      const mid = track.getBoundingClientRect().left + track.clientWidth / 2;
      let best = 0;
      let bestDist = Infinity;
      tabs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      setActive(best);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(pick, 120);
    };
    const hasScrollEnd = "onscrollend" in window;
    if (hasScrollEnd) track.addEventListener("scrollend", pick);
    else track.addEventListener("scroll", debounced, { passive: true });
    return () => {
      clearTimeout(timer);
      track.removeEventListener("scrollend", pick);
      track.removeEventListener("scroll", debounced);
    };
  }, []);

  return (
    <div className="sp-wallet" id="wallets" style={{ "--glow": look.ink } as React.CSSProperties}>
      <div className="sp-glow" aria-hidden="true" />
      <div ref={deck} className="sp-deck" role="tablist" aria-label={t.hint} onKeyDown={onKey}>
        {t.cards.map((c, i) => {
          const lk = LOOK[c.id];
          const offset = i - active;
          return (
            <button
              key={c.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              role="tab"
              id={`wallet-tab-${c.id}`}
              aria-selected={i === active}
              aria-controls="wallet-panel"
              tabIndex={i === active ? 0 : -1}
              className="sp-card"
              data-active={i === active}
              style={
                {
                  "--from": lk.from,
                  "--to": lk.to,
                  "--ink": lk.ink,
                  "--offset": offset,
                  "--abs": Math.abs(offset),
                  zIndex: 10 - Math.abs(offset),
                } as React.CSSProperties
              }
              onClick={() => choose(i)}
            >
              <span className="sp-card-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26">
                  {lk.glyph}
                </svg>
              </span>
              <span className="sp-card-name">{c.name}</span>
              <span className="sp-card-kind">{c.kind}</span>
              <span className="sp-card-chip" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="sp-dots" aria-hidden="true">
        {t.cards.map((c, i) => (
          <span key={c.id} data-on={i === active} />
        ))}
      </div>
      <div className="sp-desc-stack">
        {/* Every card's text, invisible, so the stack is as tall as the longest and nothing below jumps. */}
        <div className="sp-desc-sizer" aria-hidden="true">
          {t.cards.map((c) => (
            <Description key={c.id} card={c} locale={locale} />
          ))}
        </div>
        <Description card={card} locale={locale} id="wallet-panel" role="tabpanel" aria-labelledby={`wallet-tab-${card.id}`} aria-live="polite" />
      </div>
      {/* Without JavaScript every card is still described. */}
      <noscript>
        <ul className="sp-noscript">
          {t.cards.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong> — {c.body} {c.limits}
            </li>
          ))}
        </ul>
      </noscript>
    </div>
  );
}
