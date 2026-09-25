"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LevelBadge } from "@/components/site/Level";
import type { Locale } from "@/lib/i18n";
import { useCalm } from "@/lib/useCalm";
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

// The arrow buttons' names; content/home.ts has no strings for them.
const ARROWS: Record<Locale, { prev: string; next: string }> = {
  en: { prev: "Previous card", next: "Next card" },
  "pt-br": { prev: "Cartão anterior", next: "Próximo cartão" },
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
/** The deck deals the next card this often while it is on screen and nobody is touching it… */
const PERIOD = 3800;
/** …and holds this long after the reader picks a card themselves. */
const HOLD = 12000;

export function WalletDeck({ t, locale }: { t: HomeCopy["wallets"]; locale: Locale }) {
  const n = t.cards.length;
  const [active, setActive] = useState(0);
  // The panel announces changes the reader made, not the deck's own dealing.
  const [live, setLive] = useState(true);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const deck = useRef<HTMLDivElement>(null);
  const card = t.cards[active];
  const look = LOOK[card.id];
  const calm = useCalm();

  // Why the deck is not dealing right now, one flag per reason.
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [holding, setHolding] = useState(false);
  const [stopped, setStopped] = useState(false);
  const running = inView && visible && !calm && !stopped && !hovered && !focused && !holding;

  // Only the phone track scrolls; on desktop the cards are absolutely placed and there is nothing to bring into view.
  // The track itself is scrolled (never the page), so the deck can deal without moving the reader's viewport.
  const scrollTrackTo = useCallback((i: number, behavior: ScrollBehavior) => {
    const track = deck.current;
    const el = tabs.current[i];
    if (!track || !el || !window.matchMedia(PHONE).matches) return;
    track.scrollTo({ left: el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2, behavior });
  }, []);

  // The reader's own selection: show it, announce it, and hold the deck for a while.
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const choose = (i: number) => {
    setActive(i);
    setLive(true);
    scrollTrackTo(i, "auto");
    setHolding(true);
    clearTimeout(hold.current);
    hold.current = setTimeout(() => setHolding(false), HOLD);
  };
  useEffect(() => () => clearTimeout(hold.current), []);

  const onKey = (e: React.KeyboardEvent) => {
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

  // Dealing: one card per period, the timer resumes where it paused so it stays in step with the progress bar.
  const remaining = useRef(PERIOD);
  useEffect(() => {
    remaining.current = PERIOD;
  }, [active]);
  useEffect(() => {
    if (!running) return;
    const startedAt = performance.now();
    const timer = setTimeout(() => {
      remaining.current = PERIOD;
      const next = (active + 1) % n;
      setActive(next);
      setLive(false);
      scrollTrackTo(next, "smooth");
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt));
    };
  }, [running, active, n, scrollTrackTo]);

  // Deal only while at least half the deck is on screen, in a visible tab.
  useEffect(() => {
    const el = deck.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting && e.intersectionRatio >= 0.5), { threshold: [0.5] });
    io.observe(el);
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Phone: whichever card rests nearest the centre of the track is the active one,
  // and the first time the reader touches the track the deck stops dealing for good.
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
    const stop = () => {
      if (media.matches) setStopped(true);
    };
    const zone = track.parentElement ?? track;
    zone.addEventListener("touchstart", stop, { passive: true });
    zone.addEventListener("pointerdown", stop, { passive: true });
    zone.addEventListener("wheel", stop, { passive: true });
    return () => {
      clearTimeout(timer);
      track.removeEventListener("scrollend", pick);
      track.removeEventListener("scroll", debounced);
      zone.removeEventListener("touchstart", stop);
      zone.removeEventListener("pointerdown", stop);
      zone.removeEventListener("wheel", stop);
    };
  }, []);

  const arrows = ARROWS[locale];

  return (
    <div className="sp-wallet" id="wallets" style={{ "--glow": look.ink } as React.CSSProperties}>
      <div className="sp-glow" aria-hidden="true" />
      {/* The deck and its controls: while the pointer or the focus is here, the deck waits. */}
      <div
        className="sp-deck-zone"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        // Hold for a keyboard reader inside the tablist. A mouse click leaves focus on the button too, but
        // that selection is already covered by the timed hold and must not freeze the deck: only visible focus holds.
        onFocus={(e) => setFocused((e.target as HTMLElement).matches(":focus-visible"))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
      >
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
        <div className="sp-deck-nav">
          <div className="sp-deck-row">
            <button type="button" className="sp-deck-arrow" aria-label={arrows.prev} onClick={() => choose((active - 1 + n) % n)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* Progress: the active segment fills over one period, frozen whenever the deck is waiting. */}
            <div
              className="sp-dots"
              aria-hidden="true"
              data-running={running}
              data-progress={!calm && !stopped}
              style={{ "--period": `${PERIOD}ms` } as React.CSSProperties}
            >
              {t.cards.map((c, i) => (
                <span key={c.id} data-on={i === active} />
              ))}
            </div>
            <button type="button" className="sp-deck-arrow" aria-label={arrows.next} onClick={() => choose((active + 1) % n)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {/* The tablist already carries this name; the caption is for the eye. */}
          <span className="sp-hint caption" aria-hidden="true">
            {t.hint}
          </span>
        </div>
      </div>
      <div className="sp-desc-stack">
        {/* Every card's text, invisible, so the stack is as tall as the longest and nothing below jumps. */}
        <div className="sp-desc-sizer" aria-hidden="true">
          {t.cards.map((c) => (
            <Description key={c.id} card={c} locale={locale} />
          ))}
        </div>
        <Description
          card={card}
          locale={locale}
          id="wallet-panel"
          role="tabpanel"
          aria-labelledby={`wallet-tab-${card.id}`}
          aria-live={live ? "polite" : "off"}
        />
      </div>
      {/* Without JavaScript every card is still described. */}
      <noscript>
        <ul className="sp-noscript">
          {t.cards.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>: {c.body} {c.limits}
            </li>
          ))}
        </ul>
      </noscript>
    </div>
  );
}
