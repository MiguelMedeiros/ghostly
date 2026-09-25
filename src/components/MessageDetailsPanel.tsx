import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { MessageDetailsView } from "@ghostly/browser/shared/types";
import { useI18n } from "../contexts/I18nContext";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useIsMobile } from "../hooks/useIsMobile";
import { buildDetails, type DetailRow } from "../lib/messageDetails";
import type { ChatMessage } from "../lib/types";
import "./message-details.css";

/**
 * One message's details (WISP 400 § Message details): how it travelled, in sections a curious person can read and
 * copy. A panel from the end edge on a wide screen, a sheet from the bottom on a phone; the message stays where it
 * is, highlighted. Escape, the close button or a tap outside close it. What the engine stored comes from
 * `messageDetails`; a note kept only by this app (a call event) shows what it has.
 */
export function MessageDetailsPanel({ message, linkId, picture, onClose, returnFocus }: {
  message: ChatMessage;
  /** The chat's link, when the engine has this message; absent for a note the app keeps on its own. */
  linkId?: string;
  picture?: boolean;
  onClose: () => void;
  /** Where the focus goes back to when the panel closes. */
  returnFocus?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  // undefined: asked, not answered yet. null: the engine has nothing for this message.
  const [view, setView] = useState<MessageDetailsView | null | undefined>(undefined);
  const [copiedAll, setCopiedAll] = useState(false);
  useOutsideDismiss(ref, true, onClose);

  useEffect(() => {
    let live = true;
    if (!linkId) { setView(null); return; }
    engine.call("messageDetails", { linkId, messageId: message.id }).then(v => { if (live) setView(v); }, () => { if (live) setView(null); });
    return () => { live = false; };
    // A receipt or a resend changes what is stored: asked again when the row's state moves.
  }, [linkId, message.id, message.delivery, message.deliveryError]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const back = returnFocus;
    return () => { back?.focus({ preventScroll: true }); };
  }, [returnFocus]);

  const model = useMemo(() => buildDetails(message, view, { picture }), [message, view, picture]);
  const mine = message.sender === "me";
  const excerpt = message.file ? message.file.name : message.text.length > 90 ? `${message.text.slice(0, 90)}…` : message.text;

  const copyAll = () => {
    void navigator.clipboard?.writeText(JSON.stringify(model.json, null, 2)).then(() => { setCopiedAll(true); setTimeout(() => setCopiedAll(false), 1500); }).catch(() => {});
  };

  return createPortal(<>
    <div aria-hidden="true" data-testid="message-details-backdrop" className="fixed inset-0 z-50 bg-black/30 animate-fade-in" />
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="message-details-title" data-testid="message-details" data-side={phone ? "bottom" : "end"}
      data-loaded={view === undefined ? "no" : "yes"}
      className={`message-details-panel fixed z-50 flex flex-col bg-surface border-border shadow-2xl outline-none ${
        phone ? "inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl border-t pb-safe" : "inset-y-0 end-0 w-[min(400px,100vw)] border-s"}`}>
      <div className="flex items-start gap-3 px-4 pt-3 pb-2 border-b border-border shrink-0">
        {phone && <div aria-hidden="true" className="absolute top-1.5 inset-x-0 mx-auto h-1 w-9 rounded-full bg-border-bright" />}
        <div className="min-w-0 flex-1 pt-1">
          <h2 id="message-details-title" className="m-0 text-sm font-semibold text-text-primary">{t("chat.message.detailsTitle")}</h2>
          {/* The message, as its bubble shows it: the panel belongs to it. */}
          <div data-testid="message-details-excerpt" dir="auto" className={`mt-2 inline-block max-w-full rounded-[7.5px] px-[9px] py-[5px] text-[13px] leading-[18px] text-text-primary ${mine ? "bg-sent-bg" : "bg-received-bg"}`}>
            <span data-testid="message-details-kind" className="me-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-primary/65">{model.kind}</span>
            <span className="wrap-break-word">{excerpt}</span>
          </div>
        </div>
        <button type="button" data-testid="message-details-close" onClick={onClose} aria-label={t("chat.message.detailsClose")} title={t("chat.message.detailsClose")}
          className="shrink-0 p-1.5 -me-1.5 rounded-full text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Technical words, in English and left to right whatever the app's language, as code is. */}
      <div dir="ltr" className="flex-1 overflow-y-auto px-4 py-3 text-start">
        <p data-testid="message-details-summary" className="m-0 mb-3 text-[13px] leading-snug text-text-primary">{model.summary}</p>
        {model.sections.map(section => (
          <section key={section.id} data-testid="message-details-section" data-section={section.id} className="mb-3">
            <h3 className="m-0 mb-1 text-[10px] font-bold uppercase tracking-wider text-accent">{section.title}</h3>
            <dl className="m-0 grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
              {section.rows.map(row => <Row key={row.label} row={row} copyHint={t("chat.message.copyHint")} copied={t("chat.message.copied")} />)}
            </dl>
          </section>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border shrink-0">
        <p data-testid="message-details-keys-hint" className="m-0 text-[11px] text-text-muted">{t("chat.message.keysHint")}</p>
        <button type="button" data-testid="message-details-copy-all" onClick={copyAll}
          className="shrink-0 px-2.5 py-1 rounded border border-border bg-surface-hover text-xs font-semibold text-text-secondary hover:text-text-primary transition-colors cursor-pointer">
          {copiedAll ? t("chat.message.copied") : t("chat.message.copyJson")}
        </button>
      </div>
    </div>
  </>, document.body);
}

function Row({ row, copyHint, copied }: { row: DetailRow; copyHint: string; copied: string }) {
  const [done, setDone] = useState(false);
  const value = <span className={`message-details-value ${row.mono ? "font-mono" : ""}`}>{done ? copied : row.value}</span>;
  return <>
    <dt data-testid="message-details-label" className="text-text-muted">{row.label}</dt>
    <dd data-testid="message-details-row" data-label={row.label} data-value={row.copy ?? row.value} className="m-0 min-w-0 text-text-secondary text-start">
      {row.copy !== undefined
        ? <button type="button" data-testid="message-details-copy" title={copyHint} aria-label={`${copyHint}: ${row.label}`}
            onClick={() => { void navigator.clipboard?.writeText(row.copy!).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {}); }}
            className="bg-transparent border-none p-0 text-start text-inherit cursor-pointer hover:text-accent transition-colors">{value}</button>
        : value}
    </dd>
  </>;
}
