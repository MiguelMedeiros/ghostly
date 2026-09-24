import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../../hooks/useDismiss";
import { addableProviders, daysLeft, date, expiringSoon, providerLabel, SHARED_STATUS, useEngineState, useNewProof } from "../../lib/identities";
import { ComposerSheet, ComposerSheetHead, ForwardArrow } from "../ComposerSheet";
import { Deck } from "../deck/Deck";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace, IdCardMark } from "./IdCardFace";
import { idCard, idCardTone, type IdCardContent } from "./idCard";
import { IdentitiesIcon } from "./IdentitiesIcon";
import { ProviderMark } from "./ProviderMark";
import "./composer-identities.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Shared = NonNullable<LinkView["identities"]>["shared"][number];
/** Shared in this chat, or about to be: what the card shows as shared. */
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

/** The last card: a blank one that adds an identity. */
const ADD = "add";
type Entry = { id: string; add?: false; proof: IdentityProofView; card: IdCardContent; on: boolean } | { id: typeof ADD; add: true };

/**
 * Which of this profile's identities this chat's contact sees, as the payment picker shows the ways of paying: the
 * identities are ID cards in a stack (the Identities page's cards, on the same deck), a check seal on those shared
 * here. The chosen card's panel says what the contact will see and shares it or stops, through the same engine
 * calls as the chat's Identities dialog; the last card adds one without leaving the chat. Removing an identity
 * happens on the Identities page.
 */
export function ComposerIdentityPicker({ peerKey, contact, onClose, anchorRef }: { peerKey: string; contact: string; onClose: () => void; anchorRef?: RefObject<HTMLElement | null> }) {
  const state = useEngineState();
  const navigate = useNavigate();
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ids = link?.identities;
  const mine = state?.identityProofs ?? [];
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const titleId = `${uid}title`, panel = { id: `${uid}panel`, tabId: (id: string) => `${uid}tab-${id}` };
  // While an identity is being added, its dialog is the one on top: a click in it does not close the picker.
  useOutsideDismiss(ref, !adding, onClose, anchorRef);
  useNewProof(state, setChosen);
  // Keys reach the chosen card as the picker opens (and again after adding one: the dialog replaces the sheet while it
  // is open, since a phone's sheet sits above any dialog); closing gives the focus back to the button that opened it.
  useEffect(() => {
    if (adding) return;
    (ref.current?.querySelector<HTMLElement>('[role=tab][tabindex="0"]') ?? ref.current)?.focus({ preventScroll: true });
  }, [adding]);
  useEffect(() => {
    const anchor = anchorRef?.current;
    return () => { if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
  }, [anchorRef]);
  const now = Math.floor(Date.now() / 1000);
  const connected = link?.dataLink === "open" && link.pairing?.status === "ready";
  const unsupported = connected && !ids?.support;
  const canAdd = addableProviders().length > 0;
  const manage = () => { onClose(); navigate("/identities"); };
  const toggle = (p: IdentityProofView, on: boolean) => {
    if (!link || busy) return;
    setBusy(p.id); setError("");
    void engine.call(on ? "withdrawIdentityProof" : "shareIdentityProof", { linkId: link.id, id: p.id })
      .catch(e => setError(message(e))).finally(() => setBusy(""));
  };

  const entries: Entry[] = [
    ...mine.map((proof): Entry => {
      const shared = ids?.shared.find(s => s.id === proof.id);
      const on = isOn(shared);
      const card = idCard(proof, { now, refusedBy: on && shared?.status === "rejected" ? [contact] : [] });
      return { id: proof.id, proof, on, card: { ...card, shared: on ? `Shared with ${contact}` : `Not shared with ${contact}` } };
    }),
    ...(canAdd || mine.length === 0 ? [{ id: ADD, add: true } as const] : []),
  ];
  const entry = entries.find(e => e.id === chosen) ?? entries[0];
  const tone = (e: Entry) => (e.add ? "id-card-add" : idCardTone({ provider: e.card.provider, subject: e.card.bound, attested: e.card.attested }));
  /** Why this identity cannot be shared here now. Stopping is always possible. */
  const why = (e: Entry) => {
    if (e.add || e.on) return undefined;
    if (e.proof.expiresAt <= now) return `Expired ${date(e.proof.expiresAt)}`;
    if (ids?.contactProviders && !ids.contactProviders.includes(e.proof.provider)) return `${contact}’s app cannot verify ${providerLabel(e.proof.provider)} yet`;
    if (unsupported) return `${contact}’s app cannot receive identities yet`;
    if (!ids) return "Connect to this contact first";
    return undefined;
  };
  const select = (id: string) => { setChosen(id); setError(""); };

  if (adding) return createPortal(<AddIdentityDialog onClose={() => setAdding(false)} />, document.body);
  return (
    <ComposerSheet ref={ref} tabIndex={-1} role="dialog" aria-labelledby={titleId} data-testid="composer-identities" className={`composer-identities ${tone(entry)} focus:outline-none max-h-[70dvh] overflow-y-auto`}>
      <ComposerSheetHead title="Your identities" titleId={titleId} who={`shown to ${contact} only`} />
      <Deck<Entry> compact cards={entries} selected={entry.id} onSelect={select} onChoose={id => { if (id === ADD) setAdding(true); }}
        kind="tabs" panel={panel} label="Your identities" name="composer-identity-deck" className="id-deck" size={{ max: 250, share: .62 }}
        testId={e => (e.add ? "composer-identity-add" : "composer-identity")} blocked={why}
        face={(e, { after }) => (e.add ? <AddIdCardFace first={mine.length === 0} /> : <IdCardFace card={e.card} after={after} shared={e.on} />)}
        mark={e => <IdCardMark provider={e.add ? undefined : e.proof.provider} subject={e.add ? undefined : e.card.bound} />}
        tone={tone} />
      <div role="tabpanel" id={panel.id} aria-labelledby={panel.tabId(entry.id)} data-testid="composer-identity-panel" className="composer-identity-panel">
        {entry.add ? <IdentityToAdd first={mine.length === 0} canAdd={canAdd} onAdd={() => setAdding(true)} />
          : <IdentityToShare entry={entry} contact={contact} now={now} why={why(entry)} busy={busy} status={ids?.shared.find(s => s.id === entry.id)} onToggle={() => toggle(entry.proof, entry.on)} />}
      </div>
      {mine.length > 0 && unsupported && <p className="px-1 m-0 text-[11px] text-text-muted" data-testid="composer-identities-unsupported">{contact}’s app cannot receive identities yet.</p>}
      {(error || ids?.error) && <p role="alert" className="px-1 m-0 text-xs text-danger" data-testid="composer-identities-error">{error || ids?.error}</p>}
      {mine.length > 0 && <div className="flex items-center justify-between gap-3 px-1 pt-1 border-t border-border">
        <p className="m-0 text-[11px] text-text-muted">Stopping tells {contact}; a copy they kept stays.</p>
        <button type="button" data-testid="composer-identities-manage" onClick={manage}
          className="min-h-10 shrink-0 text-xs text-accent hover:underline cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Manage identities</button>
      </div>}
    </ComposerSheet>
  );
}

/** The chosen identity's panel: what the contact sees, where it stands in this chat, and Share or Stop sharing. */
function IdentityToShare({ entry, contact, now, why, busy, status, onToggle }: { entry: Extract<Entry, { add?: false }>; contact: string; now: number; why?: string; busy: string; status?: Shared; onToggle: () => void }) {
  const { proof: p, card, on } = entry;
  const hint = why ?? (status && status.status !== "withdrawn" ? `${SHARED_STATUS[status.status]}${status.status === "rejected" && status.error ? `: ${status.error}` : ""}` : "Not shared");
  const warn = p.expiresAt > now && expiringSoon(p, now) ? `Expires in ${daysLeft(p.expiresAt, now)} ${daysLeft(p.expiresAt, now) === 1 ? "day" : "days"}` : "";
  const tone = status?.status === "rejected" || why ? "text-danger" : status?.status === "accepted" && on ? "text-accent" : "text-text-muted";
  const working = busy === p.id;
  return (<>
    <div className="composer-identity-sees">
      <span className="composer-identity-sees-label">What {contact} sees</span>
      <span className="composer-identity-sees-value"><ProviderMark provider={p.provider} subject={card.bound} small />
        <span className="min-w-0 truncate"><span className="font-medium text-text-primary">{card.label}</span> <span className="font-mono text-xs" title={card.subject}>{card.short}</span></span></span>
      <span className="composer-identity-sees-meta">{card.category} · {card.validity}</span>
    </div>
    <p className="composer-sheet-hint" data-blocked={why ? true : undefined}>
      <span data-testid="composer-identity-status" className={why ? undefined : tone}>{hint}</span>
      {warn && <span data-testid="composer-identity-expiring" className="text-amber-500"> · {warn}</span>}
    </p>
    {/* While a call runs the button stays focusable (a disabled button would drop the keyboard's focus). */}
    <button type="button" data-testid="composer-identity-share" data-variant={on ? "secondary" : undefined} className="composer-sheet-action"
      disabled={!!why} aria-disabled={!!busy || undefined} aria-busy={working || undefined} onClick={onToggle}>
      {working ? (on ? "Stopping…" : "Sharing…") : on ? "Stop sharing" : <>Share with this chat<ForwardArrow /></>}
    </button>
  </>);
}

/** The blank card's panel: what adding an identity is, and the way to it. */
function IdentityToAdd({ first, canAdd, onAdd }: { first: boolean; canAdd: boolean; onAdd: () => void }) {
  return (
    <div className="grid gap-2.5" data-testid={first ? "composer-identities-empty" : undefined}>
      <p className="composer-sheet-hint">{first ? "No identities yet. " : ""}{canAdd ? "Prove that you hold a Nostr key, a domain or an account, then show it to the contacts you choose, one chat at a time." : "No identity can be added on this device."}</p>
      {canAdd && <button type="button" data-testid="composer-identities-add" className="composer-sheet-action" onClick={onAdd}>{first ? "Add your first identity" : "Add identity"}<ForwardArrow /></button>}
    </div>
  );
}
