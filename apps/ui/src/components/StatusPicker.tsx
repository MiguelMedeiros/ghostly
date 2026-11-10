import { useEffect, useId, useRef, useState } from "react";
import { STATUS_TEXT_MAX, type PersonStatus, type StatusAvailability } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDismiss";
import { useOwnStatus } from "../hooks/useOwnStatus";
import {
  AVAILABILITIES, AVAILABILITY_DOT, STATUS_EMOJI, STATUS_ENDS, STATUS_PICKER_EVENT, capStatusText, isolate, localDateTime,
  openStatusPicker, statusEnd, statusEndText, statusTextLength, type StatusEnd,
} from "../lib/ownStatus";
import { problemText, type Problem } from "../lib/problemText";
import { touchOnly } from "../lib/touchOnly";
import { EmojiTab } from "./composer/EmojiTab";
import { Select } from "./ui/Select";
import { Notice } from "./ui/Notice";
import { input } from "./wallet/ui";

/*
 * This profile's status (WISP 401 § Presence and status), Slack-like: its row in the account menu, and the picker that
 * sets or clears it. The engine keeps it and tells every contact; a dot by availability, one emoji, a short text and
 * when it ends.
 */

/** The availability's dot, in the theme's green, red or amber. */
export function AvailabilityDot({ availability = "available", className = "w-2.5 h-2.5" }: { availability?: StatusAvailability; className?: string }) {
  return <span aria-hidden="true" data-availability={availability} className={`inline-block shrink-0 rounded-full ${AVAILABILITY_DOT[availability]} ${className}`} />;
}

/** "Busy, 🍕 At lunch, until 11:00": a status in words, the person's text isolated. */
function useStatusWords() {
  const { t, language } = useI18n();
  return (status: PersonStatus) => [
    t(`status.availabilities.${status.availability ?? "available"}`),
    [status.emoji, status.text && isolate(status.text)].filter(Boolean).join(" "),
    status.until ? t("status.until", { time: statusEndText(status.until, language) }) : "",
  ].filter(Boolean).join(", ");
}

/** The account menu's row: the status as it stands (or "Set a status"), which opens the picker. */
export function StatusMenuItem({ className, onClose }: { className: string; onClose: () => void }) {
  const { t, language } = useI18n();
  const { status } = useOwnStatus();
  const words = useStatusWords();
  return (
    <button type="button" role="menuitem" data-testid="profile-switcher-status"
      aria-label={status ? t("status.menuLabel", { status: words(status) }) : t("status.set")}
      // The menu gives the focus back to its button as it closes: the picker hands it back there.
      onClick={() => { onClose(); openStatusPicker(); }} className={`${className} min-h-11 py-1.5 text-sm text-text-secondary`}>
      <span aria-hidden="true" className="grid place-items-center w-8 h-8 shrink-0">
        {status ? <AvailabilityDot availability={status.availability} /> : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></svg>
        )}
      </span>
      {status ? (
        <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
          {status.emoji && <span className="shrink-0">{status.emoji}</span>}
          {status.text ? <bdi dir="auto" className="min-w-0 truncate text-text-primary">{status.text}</bdi> : <span className="min-w-0 truncate text-text-primary">{t(`status.availabilities.${status.availability ?? "available"}`)}</span>}
          {status.until && <span className="shrink-0 text-xs text-text-muted">{t("status.until", { time: statusEndText(status.until, language) })}</span>}
        </span>
      ) : t("status.set")}
    </button>
  );
}

/** Where the picker opens (`openStatusPicker`), over the whole app: the menu that asked is gone by then. */
export function StatusPickerHost() {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    const show = () => setOpen((n) => n + 1);
    window.addEventListener(STATUS_PICKER_EVENT, show);
    return () => window.removeEventListener(STATUS_PICKER_EVENT, show);
  }, []);
  return open ? <StatusPickerDialog key={open} onClose={() => setOpen(0)} /> : null;
}

function StatusPickerDialog({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n();
  const { status } = useOwnStatus();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const id = useId();
  // What it stands at, to change; a new one is Available and ends today.
  const [availability, setAvailability] = useState<StatusAvailability>(status?.availability ?? "available");
  const [emoji, setEmoji] = useState(status?.emoji);
  const [text, setText] = useState(status?.text ?? "");
  // The end it opened with, held: the engine forgets the status once that passes, and Until it must not become no end.
  const [kept] = useState(status?.until);
  const [end, setEnd] = useState<StatusEnd>(status ? (kept ? "keep" : "never") : "today");
  const [at, setAt] = useState(() => localDateTime((status?.until ?? Date.now() + 3_600_000)));
  const [past, setPast] = useState(false);
  const [moreEmoji, setMoreEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setProblem(null);
    try { await work(); onClose(); } catch (e) { setProblem(problemText(e, t)); } finally { setBusy(false); }
  };
  const save = () => {
    const until = end === "keep" ? kept : end === "custom" ? new Date(at).getTime() : statusEnd(end, language);
    // A kept end can pass while the picker is open: the engine would clear the status rather than set it.
    if ((end === "keep" || end === "custom") && !(until && until > Date.now())) { setPast(true); return; }
    const words = text.trim();
    void run(() => engine.call("setOwnStatus", { status: { availability, ...(emoji ? { emoji } : {}), ...(words ? { text: words } : {}), ...(until ? { until } : {}) } }));
  };

  const emojiChoices = emoji && !(STATUS_EMOJI as readonly string[]).includes(emoji) ? [emoji, ...STATUS_EMOJI] : STATUS_EMOJI;
  const endOptions = [
    ...(kept ? [{ value: "keep" as const, label: t("status.ends.keep", { time: statusEndText(kept, language) }) }] : []),
    ...STATUS_ENDS.map((value) => ({ value, label: t(`status.ends.${value}`) })),
  ];
  const chip = "grid place-items-center w-9 h-9 max-md:w-10 max-md:h-10 rounded-full text-xl leading-none cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const button = "px-4 py-2 min-h-10 whitespace-nowrap rounded-lg text-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 animate-fade-in" {...backdrop}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="status-picker"
        className="focus:outline-none w-full max-w-sm max-h-full overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-4 space-y-4">
        <div className="space-y-1">
          <h2 id={`${id}-title`} className="text-base font-semibold text-text-primary">{t("status.title")}</h2>
          <p className="text-xs text-text-muted">{t("status.shared")}</p>
        </div>

        <div role="radiogroup" aria-labelledby={`${id}-availability`} className="space-y-1.5">
          <p id={`${id}-availability`} className="text-xs font-semibold text-text-secondary">{t("status.availability")}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {AVAILABILITIES.map((value) => (
              <label key={value} className={`flex items-center gap-2 min-h-10 px-2.5 rounded-lg border text-sm cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${availability === value ? "border-accent text-text-primary" : "border-border text-text-secondary"}`}>
                <input type="radio" name={`${id}-availability`} value={value} checked={availability === value} onChange={() => setAvailability(value)} className="sr-only" />
                <AvailabilityDot availability={value} />
                <span className="min-w-0">{t(`status.availabilities.${value}`)}</span>
              </label>
            ))}
          </div>
          {availability === "dnd" && <p className="text-xs text-text-muted">{t("status.dndHint")}</p>}
        </div>

        <div role="group" aria-labelledby={`${id}-emoji`} className="space-y-1.5">
          <p id={`${id}-emoji`} className="text-xs font-semibold text-text-secondary">{t("status.emoji")}</p>
          <div className="flex flex-wrap items-center gap-0.5">
            {emojiChoices.map((choice) => (
              <button key={choice} type="button" aria-label={choice} aria-pressed={emoji === choice} onClick={() => setEmoji(emoji === choice ? undefined : choice)}
                className={`${chip} ${emoji === choice ? "bg-accent/25" : ""}`}>{choice}</button>
            ))}
            <button type="button" aria-label={t("status.emojiMore")} title={t("status.emojiMore")} aria-expanded={moreEmoji} onClick={() => setMoreEmoji((open) => !open)}
              className={`${chip} text-text-muted hover:text-text-primary`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </div>
          {moreEmoji && (
            <div className="expression-panel" style={{ height: 300, border: 0, boxShadow: "none" }}>
              <EmojiTab onPick={(picked) => { setEmoji(picked); setMoreEmoji(false); }} autoFocus={!touchOnly()} />
            </div>
          )}
        </div>

        <div className="space-y-1">
          <input dir="auto" aria-label={t("status.text")} aria-describedby={`${id}-count`} placeholder={t("status.placeholder")} className={input}
            value={text} onChange={(e) => setText(capStatusText(e.target.value))} />
          <p id={`${id}-count`} data-testid="status-count" className="text-end text-[11px] text-text-muted tabular-nums">{statusTextLength(text)}/{STATUS_TEXT_MAX}</p>
        </div>

        <div className="space-y-1.5">
          <p id={`${id}-end`} className="text-xs font-semibold text-text-secondary">{t("status.end")}</p>
          <Select aria-labelledby={`${id}-end`} data-testid="status-end" value={end} options={endOptions} onChange={(value) => { setEnd(value); setPast(false); }} />
          {end === "custom" && (
            <input type="datetime-local" aria-label={t("status.customLabel")} className={input} value={at} min={localDateTime(Date.now())}
              aria-invalid={past || undefined} aria-describedby={past ? `${id}-past` : undefined}
              onChange={(e) => { setAt(e.target.value); setPast(false); }} />
          )}
          {past && <p id={`${id}-past`} role="alert" className="text-xs text-danger">{t("status.past")}</p>}
        </div>

        {problem && <Notice problem={problem} className="text-xs" />}
        <div className="flex flex-wrap items-center gap-2">
          {status && <button type="button" disabled={busy} onClick={() => void run(() => engine.call("clearOwnStatus"))} className={`${button} me-auto text-danger hover:bg-surface-hover`}>{t("status.clear")}</button>}
          <div className="flex gap-2 ms-auto">
            <button type="button" onClick={onClose} className={`${button} bg-surface-alt text-text-primary border border-border`}>{t("common.cancel")}</button>
            <button type="button" disabled={busy} onClick={save} className={`${button} bg-accent text-on-accent font-semibold`}>{t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
