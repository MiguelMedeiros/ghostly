"use client";

import { useRef, useState } from "react";
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

export function WalletDeck({ t, locale }: { t: HomeCopy["wallets"]; locale: Locale }) {
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const card = t.cards[active];

  const onKey = (e: React.KeyboardEvent) => {
    const n = t.cards.length;
    let next = active;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (active + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (active - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="wallet" id="wallets">
      <div className="wallet-deck" role="tablist" aria-label={t.hint} onKeyDown={onKey}>
        {t.cards.map((c, i) => {
          const look = LOOK[c.id];
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
              className="wallet-card"
              data-active={i === active}
              style={
                {
                  "--from": look.from,
                  "--to": look.to,
                  "--ink": look.ink,
                  "--offset": offset,
                  "--abs": Math.abs(offset),
                  zIndex: 10 - Math.abs(offset),
                } as React.CSSProperties
              }
              onClick={() => setActive(i)}
            >
              <span className="wallet-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26">
                  {look.glyph}
                </svg>
              </span>
              <span className="wallet-name">{c.name}</span>
              <span className="wallet-kind">{c.kind}</span>
              <span className="wallet-chip" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="wallet-panel" id="wallet-panel" role="tabpanel" aria-labelledby={`wallet-tab-${card.id}`} aria-live="polite">
        <div className="wallet-panel-head">
          <h4>
            {card.name} <span className="dim">· {card.kind}</span>
          </h4>
          <LevelBadge level={card.level} locale={locale} />
          {"more" in card && card.more && <LevelBadge level={card.more} locale={locale} small />}
        </div>
        <p>{card.body}</p>
        <p className="wallet-limits">{card.limits}</p>
      </div>
      {/* Without JavaScript every card is still described. */}
      <noscript>
        <ul className="wallet-noscript">
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
