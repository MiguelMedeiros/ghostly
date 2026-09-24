import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../../hooks/useDismiss";
import { addableProviders, daysLeft, date, expiringSoon, providerLabel, SHARED_STATUS, useEngineState, useNewProof } from "../../lib/identities";
import { ComposerSheet, ComposerSheetHead, ForwardArrow } from "../ComposerSheet";
import { Deck } from "../deck/Deck";
import { CardFlip, FlipTurnButton } from "../deck/Flip";
import { useCardFlip } from "../deck/useCardFlip";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace, IdCardMark } from "./IdCardFace";
import { idCard, idCardTone, machineLine, type IdCardContent } from "./idCard";
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
type Proof = Extract<Entry, { add?: false }>;
/** How long the back says it is done before the card turns face up again, wearing (or no longer) the seal. */
export const DONE_MS = 1200;

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** The identity as a sentence says it: "your OpenPGP key …9F04 4120", "your domain example.com". */
const spoken = (card: IdCardContent) => `your ${card.attested ? "account" : card.provider === "domain" ? "domain" : card.label} ${card.short}`;

/**
 * Which of this profile's identities this chat's contact sees, step for step as the payment picker pays: the
 * identities are ID cards in a stack (the Identities page's cards, on the same deck), a check seal on those shared
 * here, and under it one line saying what the chosen one shows the contact and one button in its colour, "Use …".
 * That turns the card over (deck/Flip.tsx, the payment card's turn): its back is what the contact sees and where it
 * stands in this chat, with Share or Stop sharing, through the same engine calls as the chat's Identities dialog.
 * Once done the back says so, then the card turns face up again. The last card adds an identity without leaving the
 * chat; removing or renewing one happens on the Identities page.
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
  /** What the back last did, said on it until the card turns face up again. */
  const [done, setDone] = useState<"shared" | "stopped" | null>(null);
  const { side, flipped, turn, turnBack } = useCardFlip();
  const ref = useRef<HTMLDivElement>(null), actionRef = useRef<HTMLButtonElement>(null);
  // While an identity is being added, its dialog is the one on top: a click in it does not close the picker.
  useOutsideDismiss(ref, !adding, onClose, anchorRef);
  useNewProof(state, setChosen);
  // On the cards, the keys start on the chosen one (as the picker opens, after adding one, back from its back): the
  // dialog replaces the sheet while it is open, since a phone's sheet sits above any dialog. Once a card has turned,
  // on its action (not as the back mounts: a face-down back takes no focus). Closing gives the focus back to the
  // button that opened it.
  useEffect(() => {
    if (adding) return;
    if (side === "cards") (ref.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]') ?? ref.current)?.focus({ preventScroll: true });
    else if (flipped) actionRef.current?.focus({ preventScroll: true });
  }, [adding, side, flipped]);
  useEffect(() => {
    const anchor = anchorRef?.current;
    return () => { if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
  }, [anchorRef]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(turnBack, DONE_MS);
    return () => clearTimeout(timer);
  }, [done, turnBack]);
  useEffect(() => { if (side === "cards") setDone(null); }, [side]);
  const now = Math.floor(Date.now() / 1000);
  const connected = link?.dataLink === "open" && link.pairing?.status === "ready";
  const unsupported = connected && !ids?.support;
  const canAdd = addableProviders().length > 0;
  const manage = () => { onClose(); navigate("/identities"); };
  const toggle = (p: IdentityProofView, on: boolean) => {
    if (!link || busy) return;
    setBusy(p.id); setError("");
    void engine.call(on ? "withdrawIdentityProof" : "shareIdentityProof", { linkId: link.id, id: p.id })
      .then(() => setDone(on ? "stopped" : "shared"), e => setError(message(e))).finally(() => setBusy(""));
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
  const expired = (e: Entry) => !e.add && !e.on && e.proof.expiresAt <= now;
  /** Why this identity cannot be shared here now. Stopping is always possible. */
  const why = (e: Entry) => {
    if (e.add || e.on) return undefined;
    if (expired(e)) return `Expired ${date(e.proof.expiresAt)}`;
    if (ids?.contactProviders && !ids.contactProviders.includes(e.proof.provider)) return `${contact}’s app cannot verify ${providerLabel(e.proof.provider)} yet`;
    if (unsupported) return `${contact}’s app cannot receive identities yet`;
    if (!ids) return "Connect to this contact first";
    return undefined;
  };
  const select = (id: string) => { setChosen(id); setError(""); };
  const use = (id: string) => {
    if (id === ADD) { setAdding(true); return; }
    setChosen(id); setError(""); setDone(null); turn();
  };
  const backToCards = () => { setError(""); turnBack(); };
  // The card turned over, while it is still there (an identity removed elsewhere meanwhile gives the cards back).
  const showing = side === "back" && !entry.add ? entry : undefined;

  if (adding) return createPortal(<AddIdentityDialog onClose={() => setAdding(false)} />, document.body);
  const blocked = why(entry);
  return (
    <ComposerSheet ref={ref} tabIndex={-1} role="dialog" aria-label="Your identities" data-testid="composer-identities" data-side={showing ? "back" : "cards"}
      className={`composer-identities ${tone(entry)} focus:outline-none max-h-[70dvh] overflow-y-auto`}>
      {showing ? <CardFlip className="composer-identity" flipped={flipped} tone={tone(showing)}
        front={<IdCardFace card={showing.card} shared={showing.on} />}
        back={<IdentityBack entry={showing} contact={contact} now={now} busy={busy} done={done} error={error} actionRef={actionRef}
          status={ids?.shared.find(s => s.id === showing.id)} onToggle={() => toggle(showing.proof, showing.on)} onCards={backToCards} />} />
      : <>
        <ComposerSheetHead title="Your identities" who={`shown to ${contact} only`} />
        <Deck<Entry> compact cards={entries} selected={entry.id} onSelect={select} onChoose={use}
          kind="radios" label="Your identities" name="composer-identity-deck" className="id-deck" size={{ max: 250, share: .62 }}
          testId={e => (e.add ? "composer-identity-add" : "composer-identity")} blocked={why}
          face={(e, { after }) => (e.add ? <AddIdCardFace first={mine.length === 0} /> : <IdCardFace card={e.card} after={after} shared={e.on} />)}
          mark={e => <IdCardMark provider={e.add ? undefined : e.proof.provider} subject={e.add ? undefined : e.card.bound} />}
          tone={tone} />
        {entry.add ? <>
          <p className="composer-sheet-hint" data-testid={mine.length === 0 ? "composer-identities-empty" : undefined}>
            {mine.length === 0 ? "No identities yet. " : ""}{canAdd ? "Prove that you hold a Nostr key, a domain or an account, then show it to the contacts you choose, one chat at a time." : "No identity can be added on this device."}
          </p>
          {canAdd && <button type="button" data-testid="composer-identities-add" className="composer-sheet-action" onClick={() => setAdding(true)}>{mine.length === 0 ? "Add your first identity" : "Add identity"}<ForwardArrow /></button>}
        </> : <>
          <p className="composer-sheet-hint" data-testid="composer-identity-hint" data-blocked={blocked ? true : undefined}>
            {blocked ?? `${contact} ${entry.on ? "sees" : "will see"} ${spoken(entry.card)}, ${lower(entry.card.category)}, ${lower(entry.card.validity)}.`}
          </p>
          {expired(entry)
            ? <button type="button" data-testid="composer-identity-use" data-action="manage" className="composer-sheet-action" onClick={manage}>Manage<ForwardArrow /></button>
            : <button type="button" data-testid="composer-identity-use" className="composer-sheet-action" disabled={!!blocked} onClick={() => use(entry.id)}>
              Use {entry.card.attested ? "this account" : entry.card.label}<ForwardArrow />
            </button>}
        </>}
        {ids?.error && <p role="alert" className="px-1 m-0 text-xs text-danger" data-testid="composer-identities-error">{ids.error}</p>}
        {mine.length > 0 && <button type="button" data-testid="composer-identities-manage" onClick={manage} className="composer-identities-manage">Manage identities</button>}
      </>}
    </ComposerSheet>
  );
}

/**
 * The chosen identity's card, turned over: what the contact sees (its mark, the identity, who stands behind it and
 * until when), where it stands in this chat, and Share or Stop sharing. Once done, a line saying so in its place.
 */
function IdentityBack({ entry, contact, now, busy, done, error, status, actionRef, onToggle, onCards }: {
  entry: Proof; contact: string; now: number; busy: string; done: "shared" | "stopped" | null; error: string; status?: Shared;
  actionRef: RefObject<HTMLButtonElement | null>; onToggle: () => void; onCards: () => void;
}) {
  const { proof: p, card, on } = entry;
  const state = status && status.status !== "withdrawn" ? `${SHARED_STATUS[status.status]}${status.status === "rejected" && status.error ? `: ${status.error}` : ""}` : "Not shared";
  const warn = p.expiresAt > now && expiringSoon(p, now) ? `Expires in ${daysLeft(p.expiresAt, now)} ${daysLeft(p.expiresAt, now) === 1 ? "day" : "days"}` : "";
  const tone = status?.status === "rejected" ? "text-danger" : status?.status === "accepted" && on ? "text-accent" : undefined;
  const working = busy === p.id;
  return (
    <div className="id-card-back" data-testid="composer-identity-back">
      <div className="id-card-back-band">
        <span className="id-card-back-title">What {contact} sees</span>
        {!done && <FlipTurnButton testId="composer-identity-change-card" label="Choose another identity" onClick={onCards} />}
      </div>
      <div className="id-card-back-body">
        <div className="id-card-back-sees" data-testid="composer-identity-sees">
          <ProviderMark provider={p.provider} subject={card.bound} />
          <span className="id-card-back-who">
            <span className="id-card-back-name">{card.label}{card.name ? ` · ${card.name}` : ""}</span>
            <span className="id-card-back-subject" title={card.subject}>{card.short}</span>
            <span className="id-card-back-meta">{card.category} · {card.validity}</span>
          </span>
        </div>
        <p className="id-card-back-state">
          <span data-testid="composer-identity-status" className={tone}>{state}</span>
          {warn && <span data-testid="composer-identity-expiring" className="text-amber-500"> · {warn}</span>}
        </p>
        {done ? <p role="status" className="id-card-back-done" data-testid="composer-identity-done">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {done === "shared" ? `Shared with ${contact}` : `${contact} no longer sees it`}
        </p> : <>
          {/* While a call runs the button stays focusable (a disabled button would drop the keyboard's focus). */}
          <button ref={actionRef} type="button" data-testid="composer-identity-share" data-variant={on ? "secondary" : undefined} className="composer-sheet-action"
            aria-disabled={!!busy || undefined} aria-busy={working || undefined} onClick={onToggle}>
            {working ? (on ? "Stopping…" : "Sharing…") : on ? "Stop sharing" : <>Share with {contact}<ForwardArrow /></>}
          </button>
          {on && <p className="id-card-back-note">Stopping tells {contact}; a copy they kept stays.</p>}
        </>}
        {error && <p role="alert" className="m-0 text-xs text-danger" data-testid="composer-identities-error">{error}</p>}
      </div>
      <span className="id-card-mrz id-card-back-mrz" aria-hidden="true">{machineLine(card.label, card.subject)}</span>
    </div>
  );
}
