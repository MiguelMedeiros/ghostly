import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useI18n } from "../contexts/I18nContext";
import { isolate } from "../lib/ownStatus";
import { Menu } from "./Menu";

/**
 * The speaker on another person's tile: a slider from 0 to 200% of how loud they play here, for you alone. At 0 they
 * are muted for you, and the tile's speaker says so. `max`: the loudest they can play here (`volumeMaxOn`: 1 on a
 * speaker Web Audio can't play on), which the slider and what it shows stop at. `host`: the call's window, which a
 * screen reader reads alone.
 */
export function TileVolume({ name, volume: set, max, onChange, host }: { name: string; volume: number; max: number; onChange: (volume: number) => void; host: RefObject<HTMLElement | null> }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const label = t("calls.group.volumeOf", { name: isolate(name) });
  const volume = Math.min(set, max);
  const off = volume === 0;
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 }).format(volume);
  useEffect(() => {
    if (open) slider.current?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div ref={anchor} className="absolute top-1.5 start-1.5 z-10">
      <button type="button" onClick={() => setOpen(!open)} data-testid="group-call-volume" data-volume={volume}
        aria-label={off ? t("calls.group.mutedForYou", { name: isolate(name) }) : label} title={off ? t("calls.group.mutedForYou", { name: isolate(name) }) : `${label}: ${percent}`}
        aria-expanded={open} aria-haspopup="true"
        className={`grid h-8 w-8 max-md:h-[44px] max-md:w-[44px] cursor-pointer place-items-center rounded-full bg-black/60 transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${off ? "text-danger" : "text-white"}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          {off ? <path d="M23 9l-6 6M17 9l6 6" /> : <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" />}
        </svg>
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} testId="group-call-volume-menu" label={label} describedBy={noteId} portal align="start" host={host.current}>
        <div className="flex items-center gap-3 px-3 py-2">
          <input ref={slider} type="range" min={0} max={max * 100} step={5} value={Math.round(volume * 100)} data-testid="group-call-volume-slider"
            aria-label={label} aria-valuetext={percent} onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
            className="min-w-0 flex-1 min-h-8 max-md:min-h-11 accent-accent cursor-pointer" />
          <span data-testid="group-call-volume-value" className="w-12 shrink-0 text-end text-sm tabular-nums text-text-primary">{percent}</span>
        </div>
        <p id={noteId} className="max-w-64 px-3 pb-2 text-xs text-text-secondary">{t("calls.group.volumeNote")}</p>
      </Menu>
    </div>
  );
}
