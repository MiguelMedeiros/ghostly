import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../contexts/SettingsContext";
import { BRAND_BUSY, enterBrandBadge, firstOpen, playBrandMotion, takeBrandTurn, type BrandCue, type BrandMotion } from "../lib/brandMotion";
import "./app-brand.css";

type Play = { motion: BrandMotion; on: BrandCue };
const WORD = "GHOSTLY";

/** The system's reduced motion; the app's own setting comes from the settings (Settings → Reduce motion). */
function systemReducesMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

interface AppBrandProps {
  testnet: boolean;
  /** Whether the wallet's mode is known yet: until then there is no telling if the Testnet badge belongs in the opening. */
  ready: boolean;
  onHome: () => void;
  onWallet: () => void;
}
/** How long the opening waits for the wallet's mode, at most, on its first frame. */
const HOLD_MAX = 1500;

/**
 * The top of the chat list: the ghost and the wordmark, which go home, and in Testnet the badge under the wordmark,
 * which opens the wallets. The logo moves briefly when the app opens and when the pointer comes over it, then rests;
 * nothing loops, and with reduced motion it stays still.
 */
export function AppBrand({ testnet, ready, onHome, onWallet }: AppBrandProps) {
  const moves = !useSettings().settings.reduceMotion && !systemReducesMotion();
  const root = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState<Play | null>(null);
  const [waited, setWaited] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The opening, made before the first paint and held on its first frame until the wallet's mode is known. */
  const held = useRef<{ motion: BrandMotion; animations: Animation[] } | null>(null);

  const busy = useCallback((motion: BrandMotion, on: BrandCue) => {
    setPlay({ motion, on });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPlay(null), BRAND_BUSY[motion][on]);
  }, []);

  // Before the first paint, so the letters and the badge don't show and then vanish to come in.
  useLayoutEffect(() => {
    if (!firstOpen() || !moves || !root.current) return;
    const motion = takeBrandTurn();
    const animations = playBrandMotion(root.current, motion, "open");
    if (ready) { busy(motion, "open"); return; }
    for (const animation of animations) animation.pause();
    held.current = { motion, animations };
    setTimeout(() => setWaited(true), HOLD_MAX);
  }, [moves, ready, busy]);

  // The mode is known (or it took too long): the badge, if there is one now, takes its part, and the opening plays.
  useLayoutEffect(() => {
    const opening = held.current;
    if (!opening || !(ready || waited) || !root.current) return;
    held.current = null;
    for (const animation of [...opening.animations, ...enterBrandBadge(root.current, opening.motion)]) animation.play();
    busy(opening.motion, "open");
  }, [ready, waited, busy]);

  const hover = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || play || held.current || !moves || !root.current) return;
    const motion = takeBrandTurn();
    playBrandMotion(root.current, motion, "hover");
    busy(motion, "hover");
  };

  return (
    // In Testnet the badge sits under the wordmark, out of the header's row, so it never takes the buttons' width.
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
        <span className={`sidebar-wordmark whitespace-nowrap text-accent font-bold text-[17px] leading-6 tracking-tight ${testnet ? "-translate-y-[7px]" : ""}`}>
          {/* One span per letter, so they can come in one after another; inline, so the word keeps its kerning. */}
          {[...WORD].map((letter, i) => <span key={i} className="app-brand-letter">{letter}</span>)}
        </span>
      </Link>
      {/* Wherever the app is, it says when its wallets are on test networks: nothing there is money. */}
      {testnet && (
        <Link to="/wallet" onClick={(e) => { e.preventDefault(); onWallet(); }} data-testid="testnet-badge" title="Wallets are on test networks: test coins, worth nothing"
          className="app-brand-badge absolute start-[42px] top-[calc(50%+3px)] rounded-full border border-amber-500/60 bg-amber-500/15 px-1.5 py-px text-[9px] font-bold uppercase leading-[12px] tracking-wider text-amber-500 hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
          Testnet
        </Link>
      )}
    </div>
  );
}
