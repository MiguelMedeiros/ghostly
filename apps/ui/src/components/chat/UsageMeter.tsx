import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usageLeft, type UsageCard } from "@ghostly/core";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { useOutsideDismiss, useTabTrap } from "../../hooks/useDismiss";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { agoIn } from "../../lib/relativeTime";
import { untilIn } from "../../lib/statusCards";
import { USAGE_TONE, resetTime, usageLevel, usageReadAt, type UsageEntry, type UsageLevel } from "../../lib/usage";
import { InfoButton } from "../layout/Section";

/*
 * A bot's usage (WISP 405 § Usage): how much of its quota is left, at a glance. A small meter and the percent on its
 * chat's row (`UsagePill`); the same in the chat's header with when it resets, a tap opening the details
 * (`UsageButton`); and the card itself in the chat, one quiet line that opens in place (`UsageView`). Colour only when
 * it runs low; muted once the numbers are stale. Every string is the card's as the reader kept it, as plain text.
 */

const icon = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** A small horizontal gauge, filled to what is left: a fuel bar, the colour of its level. */
export function UsageGauge({ left, level, className = "" }: { left: number; level: UsageLevel; className?: string }) {
  return (
    <span aria-hidden="true" data-testid="usage-gauge" className={`relative inline-block h-1.5 w-4 shrink-0 overflow-hidden rounded-full bg-text-primary/15 ${className}`}>
      <span className={`absolute inset-y-0 start-0 rounded-full ${USAGE_TONE[level].bar}`} style={{ width: `${Math.max(left, left > 0 ? 8 : 0)}%` }} />
    </span>
  );
}

/** The card's name: its label, or "Usage". */
const nameOf = (card: UsageCard, t: Translate) => card.label ?? t("cards.usage.title");

/** What a screen reader says of the meter: "Claude: 62% left, resets 18:00", "… (not updated lately)". */
function meterLabel(entry: UsageEntry, level: UsageLevel, now: number, t: Translate, language: ReturnType<typeof useI18n>["language"]): string {
  const { card } = entry;
  const said = card.resetsAt && card.resetsAt > now
    ? t("cards.usage.labelResets", { name: nameOf(card, t), left: usageLeft(card), time: resetTime(card.resetsAt, now, language) })
    : t("cards.usage.label", { name: nameOf(card, t), left: usageLeft(card) });
  return level === "stale" ? `${said} (${t("cards.usage.stale")})` : said;
}

/**
 * The meter on a chat's row: the gauge and the percent, in the level's colour (none while there is plenty). `reset`:
 * with when the window starts again ("62% · 18:00"), as the header shows it.
 */
export function UsagePill({ entry, testId, reset = false, className = "" }: { entry: UsageEntry; testId: string; reset?: boolean; className?: string }) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const now = useMinuteClock(ref);
  const level = usageLevel(entry, now);
  const left = usageLeft(entry.card);
  const tone = USAGE_TONE[level];
  const label = meterLabel(entry, level, now, t, language);
  const resets = reset && level !== "stale" && entry.card.resetsAt ? resetTime(entry.card.resetsAt, now, language) : undefined;
  return (
    <span ref={ref} role="img" aria-label={label} title={label} data-testid={testId} data-level={level} data-left={left}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 h-[18px] text-[11px] font-medium leading-none tabular-nums whitespace-nowrap ${tone.pill} ${tone.text} ${className}`}>
      <UsageGauge left={left} level={level} />
      <span dir="ltr">{left}%</span>
      {resets && <><span aria-hidden="true" className="opacity-60">·</span><span>{resets}</span></>}
    </span>
  );
}

/** The details: what is left of which window and when it resets, the account, the other windows, when it was said. */
export function UsageDetails({ entry, now }: { entry: UsageEntry; now: number }) {
  const { t, language } = useI18n();
  const { card } = entry;
  const level = usageLevel(entry, now);
  const ago = agoIn(language);
  // "18:00 · in 3 h": the time, and how long until then.
  const when = (at: number) => `${resetTime(at, now, language)} · ${untilIn(language)(at, now)}`;
  const rows: [string, ReactNode, string][] = [
    [t("cards.usage.leftLabel"), <><span dir="ltr">{usageLeft(card)}%</span>{card.window && <> · <bdi>{card.window}</bdi></>}</>, "left"],
    ...(card.used !== undefined && card.limit !== undefined ? [[t("cards.usage.usedLabel"), t("cards.usage.used", { used: card.used, limit: card.limit }), "used"] as [string, ReactNode, string]] : []),
    ...(card.resetsAt ? [[t("cards.usage.resetsLabel"), when(card.resetsAt), "resets"] as [string, ReactNode, string]] : []),
    ...(card.account ? [[t("cards.usage.accountLabel"), <bdi>{card.account}</bdi>, "account"] as [string, ReactNode, string]] : []),
    ...(card.windows ?? []).map((w, i) => [w.window, <>{t("cards.usage.left", { left: w.left })}{w.resetsAt && <> · {t("cards.usage.resets", { time: resetTime(w.resetsAt, now, language) })}</>}</>, `window-${i}`] as [string, ReactNode, string]),
    [t("cards.usage.updatedLabel"), ago(usageReadAt(entry) / 1000, now / 1000), "updated"],
  ];
  return (
    <div data-testid="usage-details" data-level={level} className="flex flex-col gap-1.5 text-xs leading-snug">
      {level === "stale" && <p data-testid="usage-details-stale" className="m-0 text-text-muted">{t("cards.usage.staleHint")}</p>}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([term, value, key]) => (
          <div key={key} data-testid={`usage-details-${key}`} className="contents">
            <dt className="text-text-muted"><bdi>{term}</bdi></dt>
            <dd className="m-0 min-w-0 text-text-primary [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Where the popover goes: under the pill, from its start edge, inside the window. */
function usePlace(phone: boolean, anchorRef: RefObject<HTMLElement | null>, width: number) {
  const [place, setPlace] = useState<{ left: number; top: number; width: number }>();
  useLayoutEffect(() => {
    if (phone) return;
    const fit = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const opener = anchor.getBoundingClientRect();
      const w = Math.min(width, vw - 16);
      const start = getComputedStyle(anchor).direction === "rtl" ? opener.right - w : opener.left;
      setPlace({ left: Math.max(8, Math.min(start, vw - 8 - w)), top: opener.bottom + 4, width: w });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [phone, anchorRef, width]);
  return place;
}

function UsagePanel({ entry, anchorRef, onClose }: { entry: UsageEntry; anchorRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId(), infoId = useId();
  const [info, setInfo] = useState(false);
  const now = useMinuteClock(ref);
  const place = usePlace(phone, anchorRef, 300);
  useOutsideDismiss(ref, true, onClose, anchorRef);
  useTabTrap(ref);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const body = <>
    <div className={`flex items-center gap-1.5 ps-3 pe-1.5 ${phone ? "pt-4" : "pt-2"}`}>
      {phone && <div aria-hidden="true" className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-border-bright" />}
      <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-text-primary"><bdi>{nameOf(entry.card, t)}</bdi></h2>
      <InfoButton open={info} onToggle={() => setInfo(!info)} controls={infoId} testId="chat-usage-info" />
      <button type="button" data-testid="chat-usage-close" onClick={onClose} aria-label={t("cards.panel.close")} title={t("cards.panel.close")}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-hover cursor-pointer">
        <svg {...icon}><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
    {info && <p id={infoId} data-testid="chat-usage-info-text" className="m-0 px-3 pt-1 text-xs leading-relaxed text-text-secondary">{t("cards.usage.info")}</p>}
    <div className={phone ? "pb-safe" : ""}><div className={`px-3 pt-2 ${phone ? "pb-5" : "pb-3"}`}><UsageDetails entry={entry} now={now} /></div></div>
  </>;
  const common = { ref, role: "dialog", "aria-modal": true, "aria-labelledby": titleId, tabIndex: -1, "data-testid": "chat-usage-panel",
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } } } as const;
  if (phone) return createPortal(<>
    <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/40 animate-fade-in" />
    <div {...common} data-layout="sheet" className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border-t border-border bg-surface-alt shadow-2xl outline-none animate-fade-in">{body}</div>
  </>, document.body);
  return createPortal(
    <div {...common} data-layout="popover" style={place ? { left: place.left, top: place.top, width: place.width } : { visibility: "hidden" }}
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-surface-alt shadow-lg outline-none animate-fade-in">{body}</div>, document.body);
}

/** The meter in a chat's header, with when it resets: a tap opens the details (a sheet on a phone). */
export function UsageButton({ entry }: { entry: UsageEntry }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    const at = document.activeElement;
    setOpen(false);
    if (!at || at === document.body || at.closest("[data-testid=chat-usage-panel]")) button.current?.focus({ preventScroll: true });
  };
  return (
    <span ref={ref} className="inline-flex shrink-0">
      <button ref={button} type="button" data-testid="chat-usage-open" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex rounded-full cursor-pointer hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent">
        <UsagePill entry={entry} testId="chat-usage" reset />
      </button>
      {open && <UsagePanel entry={entry} anchorRef={ref} onClose={close} />}
    </span>
  );
}

/**
 * A usage card in the chat: one quiet line (the gauge, the name, what is left, when it resets) with the card's time and
 * marks at its end; a tap, a click or Enter opens the details in place. Updates are edits: it stays one message.
 */
export function UsageView({ card, at, time, marks }: { card: UsageCard; at: number; time?: ReactNode; marks?: ReactNode }) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const now = useMinuteClock(ref);
  const entry: UsageEntry = { card, messageId: "", at };
  const level = usageLevel(entry, now);
  const left = usageLeft(card);
  const resets = level !== "stale" && card.resetsAt ? t("cards.usage.resets", { time: resetTime(card.resetsAt, now, language) }) : undefined;
  return (
    <div ref={ref} data-testid="status-card" data-kind="usage" data-card-id={card.id} data-level={level} data-left={left} data-open={open ? "" : undefined} className="w-full min-w-0 text-start">
      {/* Two short lines, as a task's: the meter, the name and what is left; then when it resets, and the card's time. */}
      <button type="button" data-testid="status-card-toggle" data-press-through aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}
        className="block w-full cursor-pointer rounded-t-[9px] px-3.5 pt-2.5 pb-1 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
        <span className="flex min-w-0 items-center gap-2">
          <UsageGauge left={left} level={level} className="!w-6 !h-2" />
          <bdi data-testid="status-card-title" className="min-w-0 flex-1 truncate text-[13.5px] font-semibold leading-5">{nameOf(card, t)}</bdi>
          <span className={`shrink-0 text-[12px] font-medium leading-5 tabular-nums ${USAGE_TONE[level].text}`}>{t("cards.usage.left", { left })}</span>
        </span>
      </button>
      {open && <div id={detailsId} className="mx-3.5 mt-1 border-t border-text-primary/10 pb-1 pt-2"><UsageDetails entry={entry} now={now} /></div>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-3.5 pb-2 pt-1 text-[11.5px] leading-4 text-text-secondary">
        {resets && <span data-testid="status-card-resets" className="min-w-0 truncate">{resets}</span>}
        {(time || marks) && <span className="ms-auto flex shrink-0 items-center gap-[3px] text-[11px]">{time}{marks}</span>}
      </div>
    </div>
  );
}
