import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { BRAND_BUSY, firstOpen, playBrandMotion, takeBrandTurn, type BrandCue, type BrandMotion } from "../lib/brandMotion";
import "./app-brand.css";

type Play = { motion: BrandMotion; on: BrandCue };
const WORD = "GHOSTLY";

/** The system's reduced motion; the app's own setting comes from the settings (Settings → Reduce motion). */
function systemReducesMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

interface AppBrandProps {
  onHome: () => void;
}

/**
 * The top of the chat list: the ghost and the wordmark, which go home. The logo moves briefly when the app opens and
 * when the pointer comes over it, then rests; nothing loops, and with reduced motion it stays still. Wallets say their
 * own network on their cards: nothing here is about money.
 */
export function AppBrand({ onHome }: AppBrandProps) {
  const moves = !useSettings().settings.reduceMotion && !systemReducesMotion();
  const root = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState<Play | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const busy = useCallback((motion: BrandMotion, on: BrandCue) => {
    setPlay({ motion, on });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPlay(null), BRAND_BUSY[motion][on]);
  }, []);

  // Before the first paint, so the letters don't show and then vanish to come in.
  useLayoutEffect(() => {
    if (!firstOpen() || !moves || !root.current) return;
    const motion = takeBrandTurn();
    playBrandMotion(root.current, motion, "open");
    busy(motion, "open");
  }, [moves, busy]);

  const hover = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || play || !moves || !root.current) return;
    const motion = takeBrandTurn();
    playBrandMotion(root.current, motion, "hover");
    busy(motion, "hover");
  };

  return (
    <div ref={root} className="app-brand relative flex shrink-0 items-center" data-testid="app-brand" data-motion={play?.motion} data-on={play?.on}
      onPointerEnter={hover}>
      <Link to="/" onClick={(e) => { e.preventDefault(); onHome(); }} aria-label="Go home" title="Go home" className="sidebar-home flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg width="36" height="36" viewBox="0 0 64 64" className="app-brand-ghost shrink-0" aria-hidden="true">
          <g transform="translate(12, 8)">
            <path d="M20 4C10.059 4 2 12.059 2 22v18c0 1.5 1.2 2 2 1.2l4-3.2 4 3.2c.8.6 1.6.6 2.4 0L18 38l3.6 3.2c.8.6 1.6.6 2.4 0L28 38l4 3.2c.8.8 2 .3 2-1.2V22C34 12.059 25.941 4 20 4z" fill="currentColor" className="text-accent"/>
            <g className="app-brand-eyes">
              <circle cx="13" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
              <circle cx="27" cy="20" r="3" fill="currentColor" className="text-sidebar-bg"/>
            </g>
          </g>
        </svg>
        <span className="sidebar-wordmark whitespace-nowrap text-accent font-bold text-[17px] leading-6 tracking-tight">
          {/* One span per letter, so they can come in one after another; inline, so the word keeps its kerning. */}
          {[...WORD].map((letter, i) => <span key={i} className="app-brand-letter">{letter}</span>)}
        </span>
      </Link>
    </div>
  );
}
