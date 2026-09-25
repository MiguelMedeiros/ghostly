import { useEffect, useRef, useState } from "react";
import { decodeInviteCode, encodeInviteCode, inviteQrSegments } from "@ghostly/core";
import { inviteShareText } from "../lib/url";
import { engine } from "@ghostly/browser/platform/engine";
import { saveInviteCode } from "../lib/storage";
import { useOutsideDismiss } from "../hooks/useDismiss";
import { useI18n } from "../contexts/I18nContext";
import { QRCodeDisplay } from "./QRCode";

/**
 * The QR and the copied link are the same capability. A `ghostly1` code is shared as its link
 * (`https://ghostly.tools/#ghostly1…`) and its QR is that link in capitals; a code saved before
 * this format stays as it was.
 */
export function InviteCard({ code, sessionId, linkId, mode, onChange }: { code: string; sessionId: string; linkId?: string; mode: "stream" | "dht"; onChange(code: string): void }) {
  const { t } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(detailsRef, detailsOpen, () => setDetailsOpen(false));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const parsed = decodeInviteCode(code);
  const effectiveCode = parsed?.profile ? encodeInviteCode({ ...parsed, deliveryMode: mode }) : code;
  const shared = inviteShareText(effectiveCode);
  useEffect(() => {
    if (effectiveCode !== code) { saveInviteCode(sessionId, effectiveCode); onChange(effectiveCode); }
  }, [effectiveCode, code, sessionId, onChange]);
  const change = async (next: "stream" | "dht") => {
    if (!parsed || !linkId || busy) return;
    setBusy(true); setError("");
    try {
      await engine.call("setDeliveryMode", { linkId, mode: next });
      const updated = encodeInviteCode({ ...parsed, deliveryMode: next });
      saveInviteCode(sessionId, updated); onChange(updated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change delivery."); }
    finally { setBusy(false); }
  };
  return <div data-testid="invite-card" className="mx-auto my-3 w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-border bg-surface-alt/95 p-4 text-center">
    <h2 className="mb-3 text-sm font-medium text-text-primary">Invite your contact</h2>
    {parsed?.profile && <div ref={detailsRef} className="relative mb-4 flex items-center gap-1"><fieldset disabled={busy || !linkId} className="flex min-w-0 flex-1 rounded-lg bg-input-bg p-1 text-xs">
      <legend className="sr-only">Initial delivery</legend>
      {(["stream", "dht"] as const).map(value => <label key={value} className={`relative flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-md ${mode === value ? "bg-surface-hover text-accent" : "text-text-muted"}`}>
        <input type="radio" name={`invite-mode-${sessionId}`} aria-label={value === "stream" ? t("invite.live") : t("invite.text")} checked={mode === value} onChange={() => void change(value)} className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        <span className="pointer-events-none flex items-center gap-1.5 rounded peer-focus-visible:ring-2 peer-focus-visible:ring-accent">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            {value === "stream" ? <path d="M8 8H6a4 4 0 0 0 0 8h2m8-8h2a4 4 0 0 1 0 8h-2M8 12h8"/> : <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM7 8h10M7 12h6"/>}
          </svg>
          {value === "stream" ? t("invite.live") : t("invite.text")}
        </span>
      </label>)}
    </fieldset>
      <button type="button" aria-label={t("invite.details")} aria-expanded={detailsOpen} aria-controls="invite-delivery-details" onClick={() => setDetailsOpen(open => !open)}
        className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted cursor-pointer hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>
      </button>
      {detailsOpen && <div id="invite-delivery-details" role="region" aria-label={t("invite.details")} className="absolute right-0 top-full z-20 mt-2 w-72 max-w-full rounded-lg border border-border bg-sidebar-bg p-3 text-left text-xs leading-relaxed text-text-secondary shadow-xl">{t("invite.textDetails")}</div>}
    </div>}
    {busy ? <p className="py-20 text-xs text-text-muted" role="status">Updating invite…</p> : <>
      <QRCodeDisplay value={shared} qr={inviteQrSegments(effectiveCode)} />
      {shared !== effectiveCode && <p data-testid="invite-link" title={shared} dir="ltr" className="mt-2 truncate font-mono text-[11px] text-text-muted">{shared.replace(/^https:\/\//, "")}</p>}
    </>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}
