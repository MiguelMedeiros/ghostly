import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../../hooks/useDismiss";
import { daysLeft, date, expiringSoon, providerLabel, SHARED_STATUS, shortSubject, useEngineState } from "../../lib/identities";
import { IdentitiesIcon } from "./IdentitiesIcon";
import { ProviderMark } from "./ProviderMark";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Shared = NonNullable<LinkView["identities"]>["shared"][number];
/** Shared in this chat, or about to be: what the switch shows as on. */
const isOn = (s?: Shared) => !!s && s.status !== "withdrawn" && s.status !== "withdrawal-pending";

const useLink = (peerKey: string) => useEngineState()?.links.find(l => l.peerPubKeyZ32 === peerKey);

/** The composer's identity button: an ID card, with how many of this profile's identities this chat has. */
export function ComposerIdentityButton({ peerKey, open, onToggle, buttonRef }: { peerKey: string; open: boolean; onToggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  const count = useLink(peerKey)?.identities?.shared.filter(isOn).length ?? 0;
  const label = count ? `Share identities in this chat, ${count} shared` : "Share identities in this chat";
  return (
    <button ref={buttonRef} type="button" onClick={onToggle} data-testid="composer-identities-button" data-count={count}
      aria-expanded={open} aria-haspopup="dialog" aria-label={label} title={label}
      className={`relative w-9 h-9 max-md:w-10 max-md:h-11 flex items-center justify-center rounded-full transition-colors cursor-pointer border-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        open ? "bg-accent/20 text-accent" : "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-hover"}`}>
      <IdentitiesIcon size={20} />
      {count > 0 && <span aria-hidden="true" data-testid="composer-identities-count"
        className="absolute -top-0.5 -right-0.5 max-md:top-0 max-md:right-0 min-w-4 h-4 px-1 rounded-full bg-accent text-[#111b21] text-[10px] font-semibold leading-4 text-center ring-2 ring-panel-header">{count}</span>}
    </button>
  );
}

/**
 * Which of this profile's identities this chat's contact sees, one switch each: sharing and stopping are one
 * tap, through the same engine calls as the chat's Identities dialog. Adding and removing happen on the
 * Identities page.
 */
export function ComposerIdentityPicker({ peerKey, contact, onClose, anchorRef }: { peerKey: string; contact: string; onClose: () => void; anchorRef?: RefObject<HTMLElement | null> }) {
  const state = useEngineState();
  const navigate = useNavigate();
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ids = link?.identities;
  const mine = state?.identityProofs ?? [];
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOutsideDismiss(ref, true, onClose, anchorRef);
  // Keys reach the picker as it opens; closing gives the focus back to the button that opened it.
  useEffect(() => {
    const anchor = anchorRef?.current;
    (ref.current?.querySelector<HTMLElement>("[role=switch]:not(:disabled), a, button") ?? ref.current)?.focus({ preventScroll: true });
    return () => { if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
  }, [anchorRef]);
  const now = Math.floor(Date.now() / 1000);
  const connected = link?.dataLink === "open" && link.pairing?.status === "ready";
  const unsupported = connected && !ids?.support;
  const manage = () => { onClose(); navigate("/identities"); };
  const toggle = (p: IdentityProofView, on: boolean) => {
    if (!link) return;
    setBusy(p.id); setError("");
    void engine.call(on ? "withdrawIdentityProof" : "shareIdentityProof", { linkId: link.id, id: p.id })
      .catch(e => setError(message(e))).finally(() => setBusy(""));
  };

  return (<>
    <div className="sheet-backdrop" />
    <div ref={ref} tabIndex={-1} role="dialog" aria-labelledby={titleId} data-testid="composer-identities"
      className="sheet sheet-padded absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[340px] max-w-[calc(100vw-1.5rem)] max-h-[70dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-3 space-y-2 focus:outline-none">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 id={titleId} className="text-sm font-medium text-text-primary">Your identities</h2>
        <span className="text-[11px] text-text-muted truncate">shown to {contact} only</span>
      </div>
      {mine.length === 0 ? (
        <div data-testid="composer-identities-empty" className="rounded-xl border border-dashed border-border p-3 text-center space-y-2">
          <p className="text-xs text-text-muted">No identities yet</p>
          <button type="button" data-testid="composer-identities-add" onClick={manage}
            className="min-h-10 px-3 rounded-lg text-sm text-accent hover:bg-surface-alt cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Add one</button>
        </div>
      ) : <ul className="space-y-1">{mine.map(p => {
        const shared = ids?.shared.find(s => s.id === p.id);
        const on = isOn(shared);
        const expired = p.expiresAt <= now;
        const cannot = !!ids?.contactProviders && !ids.contactProviders.includes(p.provider);
        // Stopping is always possible; sharing needs a proof still valid and a contact that can take it.
        const blocked = !on && (expired || cannot || unsupported || !ids);
        const hint = expired ? `Expired ${date(p.expiresAt)}`
          : !on && cannot ? `${contact}’s app cannot verify ${providerLabel(p.provider)} yet`
          : shared && shared.status !== "withdrawn" ? `${SHARED_STATUS[shared.status]}${shared.status === "rejected" && shared.error ? `: ${shared.error}` : ""}`
          : "Not shared";
        const warn = !expired && expiringSoon(p, now) ? `Expires in ${daysLeft(p.expiresAt, now)} ${daysLeft(p.expiresAt, now) === 1 ? "day" : "days"}` : "";
        const tone = shared?.status === "rejected" || expired ? "text-danger" : shared?.status === "accepted" && on ? "text-accent" : "text-text-muted";
        return (
          <li key={p.id}>
            <button type="button" role="switch" aria-checked={on} aria-labelledby={`${titleId}-${p.id}`} aria-describedby={`${titleId}-${p.id}-hint`}
              // While a call runs the switches stay focusable (a disabled button would drop the keyboard's focus).
              aria-busy={busy === p.id || undefined} aria-disabled={!!busy || undefined} disabled={blocked} onClick={() => { if (!busy) toggle(p, on); }}
              data-testid="composer-identity" data-provider={p.provider} data-shared={on}
              className="w-full flex items-center gap-3 rounded-xl p-2 min-h-12 text-left hover:bg-surface-alt cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <ProviderMark provider={p.provider} subject={p.verified.subject} />
              <span className="min-w-0 flex-1">
                <span id={`${titleId}-${p.id}`} className="block text-sm text-text-primary truncate">{providerLabel(p.provider)} <span className="font-mono text-xs text-text-muted">{shortSubject(p.provider, p.verified.subject)}</span></span>
                <span id={`${titleId}-${p.id}-hint`} className="block text-[11px] leading-4">
                  <span data-testid="composer-identity-status" className={tone}>{busy === p.id ? (on ? "Stopping…" : "Sharing…") : hint}</span>
                  {warn && <span data-testid="composer-identity-expiring" className="text-amber-500"> · {warn}</span>}
                </span>
              </span>
              <span aria-hidden="true" className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${on ? "bg-accent" : "bg-surface-alt border border-border"}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
              </span>
            </button>
          </li>
        );
      })}</ul>}
      {mine.length > 0 && unsupported && <p className="px-1 text-[11px] text-text-muted" data-testid="composer-identities-unsupported">{contact}’s app cannot receive identities yet.</p>}
      {(error || ids?.error) && <p role="alert" className="px-1 text-xs text-danger" data-testid="composer-identities-error">{error || ids?.error}</p>}
      {mine.length > 0 && <div className="flex items-center justify-between gap-3 px-1 pt-1 border-t border-border">
        <p className="text-[11px] text-text-muted">Stopping tells {contact}; a copy they kept stays.</p>
        <button type="button" data-testid="composer-identities-manage" onClick={manage}
          className="min-h-10 shrink-0 text-xs text-accent hover:underline cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Manage identities</button>
      </div>}
    </div>
  </>);
}
