import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { useOutsideDismiss } from "../../hooks/useDismiss";
import { useCopyKey } from "../../hooks/useCopyKey";
import { addableProviders, daysLeft, date, expiringSoon, providerLabel, SHARED_STATUS, useEngineState, useNewProof } from "../../lib/identities";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { ComposerSheet, ComposerSheetHead, ForwardArrow } from "../ComposerSheet";
import { Deck } from "../deck/Deck";
import { CardFlip, FlipTurnButton } from "../deck/Flip";
import { useCardFlip } from "../deck/useCardFlip";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace, IdCardMark } from "./IdCardFace";
import { GHOSTLY, ghostlyCard, idCard, idCardTone, machineLine, type IdCardContent } from "./idCard";
import { ProviderMark } from "./ProviderMark";
import { PublicProfileDetails } from "./PublicProfileDetails";
import "./composer-identities.css";
import { useAppNavigation } from "../../hooks/useAppNavigation";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Shared = NonNullable<LinkView["identities"]>["shared"][number];
/** Shared in this chat, or about to be: what the card shows as shared. */
const isOn = (s?: Shared) => !!s && s.status !== "withdrawn" && s.status !== "withdrawal-pending";

/** How many of this profile's identities the chat's contact sees: the + menu's Identity row says it. */
export function useSharedIdentityCount(peerKey?: string): number {
  const link = useEngineState()?.links.find(l => !!peerKey && l.peerPubKeyZ32 === peerKey);
  return link?.identities?.shared.filter(isOn).length ?? 0;
}

/** The last card: a blank one that adds an identity. */
const ADD = "add";
type Entry =
  | { id: string; add?: false; ghostly?: false; proof: IdentityProofView; card: IdCardContent; on: boolean }
  | { id: typeof GHOSTLY; add?: false; ghostly: true; card: IdCardContent; on: true }
  | { id: typeof ADD; add: true; ghostly?: false };
type Proof = Extract<Entry, { proof: IdentityProofView }>;
type Ghostly = Extract<Entry, { ghostly: true }>;
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
  const nav = useAppNavigation();
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // While an identity is being added, its dialog is the one on top: a click in it does not close the picker.
  useOutsideDismiss(ref, !adding, onClose, anchorRef);
  // Closing gives the focus back to the button that opened it.
  useEffect(() => {
    const anchor = anchorRef?.current;
    return () => { if (anchor?.isConnected) anchor.focus({ preventScroll: true }); };
  }, [anchorRef]);
  return <IdentityPicker peerKey={peerKey} contact={contact} onManage={() => { onClose(); nav.open("/identities"); }} onAdding={setAdding} head focusOnOpen
    frame={({ side, tone }, children) => (
      <ComposerSheet ref={ref} tabIndex={-1} role="dialog" aria-label="Your identities" data-testid="composer-identities" data-side={side}
        className={`composer-identities ${tone} focus:outline-none max-h-[70dvh] overflow-y-auto`}>{children}</ComposerSheet>
    )} />;
}

/**
 * The identity picker itself, wherever it is shown: in the composer's sheet (ComposerIdentityPicker), and under
 * "Yours, for this contact" in the chat's identities panel (ContactIdentitiesPanel.tsx). `frame` wraps it (the sheet,
 * or the panel's section), wearing the chosen card's colour; `head` shows the sheet's title over the cards. With
 * `focusOnOpen` the keys start on the chosen card as it opens (the sheet); the panel keeps its own focus.
 *
 * The first card is the profile's Ghostly identity, what the contact sees in any case: its name and picture, and
 * this chat's key. Its back shows the key in full, to copy, and "Share only this" takes every other identity back
 * from this contact, which is the picker's default state.
 */
export function IdentityPicker({ peerKey, contact, onManage, onAdding, frame, head = false, focusOnOpen = false }: {
  peerKey: string; contact: string; onManage: () => void; onAdding?: (adding: boolean) => void;
  frame: (place: { side: "cards" | "back"; tone: string }, children: ReactNode) => ReactNode; head?: boolean; focusOnOpen?: boolean;
}) {
  const state = useEngineState();
  const { t } = useI18n();
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ids = link?.identities;
  const mine = state?.identityProofs ?? [];
  const [chosen, setChosen] = useState<string>();
  const [adding, setAddingState] = useState(false);
  const setAdding = (on: boolean) => { setAddingState(on); onAdding?.(on); };
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  /** What the back last did, said on it until the card turns face up again. */
  const [done, setDone] = useState<"shared" | "stopped" | "only" | null>(null);
  const { side, flipped, turn, turnBack } = useCardFlip();
  const ref = useRef<HTMLDivElement>(null), actionRef = useRef<HTMLButtonElement>(null);
  useNewProof(state, setChosen);
  // On the cards, the keys start on the chosen one (as the sheet opens, after adding one, back from its back): the
  // dialog replaces the sheet while it is open, since a phone's sheet sits above any dialog. Once a card has turned,
  // on its action (not as the back mounts: a face-down back takes no focus).
  const opened = useRef(false);
  useEffect(() => {
    if (adding) return;
    const first = !opened.current; opened.current = true;
    if (side === "cards") { if (!first || focusOnOpen) ref.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]')?.focus({ preventScroll: true }); }
    else if (flipped) actionRef.current?.focus({ preventScroll: true });
  }, [adding, side, flipped, focusOnOpen]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(turnBack, DONE_MS);
    return () => clearTimeout(timer);
  }, [done, turnBack]);
  useEffect(() => { if (side === "cards") setDone(null); }, [side]);
  const now = Math.floor(Date.now() / 1000);
  const connected = link?.dataLink === "open" && link.pairing?.status === "ready";
  const unsupported = connected && !ids?.support;
  const providers = addableProviders().map(p => p.id);
  const canAdd = providers.length > 0;
  const manage = onManage;
  const toggle = (p: IdentityProofView, on: boolean) => {
    if (!link || busy) return;
    setBusy(p.id); setError("");
    void engine.call(on ? "withdrawIdentityProof" : "shareIdentityProof", { linkId: link.id, id: p.id })
      .then(() => setDone(on ? "stopped" : "shared"), e => setError(message(e))).finally(() => setBusy(""));
  };

  const ghostly: Ghostly | undefined = state && link ? {
    id: GHOSTLY, ghostly: true, on: true,
    card: ghostlyCard(t, { nick: state.settings.nick, avatar: state.settings.avatar, shareProfile: state.settings.shareProfile !== false }, { chat: { key: link.myPubKeyZ32, contact } }),
  } : undefined;
  const proofs = mine.map((proof): Proof => {
    const shared = ids?.shared.find(s => s.id === proof.id);
    const on = isOn(shared);
    const card = idCard(proof, { now, refusedBy: on && shared?.status === "rejected" ? [contact] : [] });
    return { id: proof.id, proof, on, card: { ...card, shared: on ? `Shared with ${contact}` : `Not shared with ${contact}` } };
  });
  /** The other identities the contact sees now: what "Share only this" on the Ghostly card takes back. */
  const others = proofs.filter(p => p.on);
  const entries: Entry[] = [
    ...(ghostly ? [ghostly] : []),
    ...proofs,
    ...(canAdd || mine.length === 0 ? [{ id: ADD, add: true } as const] : []),
  ];
  const entry = entries.find(e => e.id === chosen) ?? entries[0];
  const tone = (e: Entry) => (e.add ? "id-card-add" : idCardTone({ provider: e.card.provider, subject: e.card.bound, attested: e.card.attested }));
  const expired = (e: Entry) => !e.add && !e.ghostly && !e.on && e.proof.expiresAt <= now;
  /** Why this identity cannot be shared here now. Stopping is always possible; the Ghostly identity is always seen. */
  const why = (e: Entry) => {
    if (e.add || e.ghostly || e.on) return undefined;
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
  /** The Ghostly card's action: every other identity shared here is taken back, so the contact sees only it. */
  const shareOnlyGhostly = () => {
    if (!link || busy || others.length === 0) return;
    setBusy(GHOSTLY); setError("");
    void Promise.all(others.map(p => engine.call("withdrawIdentityProof", { linkId: link.id, id: p.id })))
      .then(() => setDone("only"), e => setError(message(e))).finally(() => setBusy(""));
  };
  // The card turned over, while it is still there (an identity removed elsewhere meanwhile gives the cards back).
  const showing = side === "back" && !entry.add ? entry : undefined;

  if (adding) return createPortal(<AddIdentityDialog onClose={() => setAdding(false)} />, document.body);
  const blocked = why(entry);
  return (
    frame({ side: showing ? "back" : "cards", tone: tone(entry) }, <div ref={ref} className="identity-picker">
      {showing ? <CardFlip className="composer-identity" flipped={flipped} tone={tone(showing)}
        front={<IdCardFace card={showing.card} shared={showing.on} />}
        back={showing.ghostly
          ? <GhostlyBack t={t} card={showing.card} contact={contact} others={others.length} busy={busy} done={done} error={error} actionRef={actionRef} onShareOnly={shareOnlyGhostly} onCards={backToCards} />
          : <IdentityBack entry={showing} contact={contact} now={now} busy={busy} done={done} error={error} actionRef={actionRef}
            status={ids?.shared.find(s => s.id === showing.id)} onToggle={() => toggle(showing.proof, showing.on)} onCards={backToCards} />} />
      : <>
        {head && <ComposerSheetHead title="Your identities" who={`shown to ${contact} only`} />}
        <Deck<Entry> compact cards={entries} selected={entry.id} onSelect={select} onChoose={use}
          kind="radios" label="Your identities" name="composer-identity-deck" className="id-deck" size={{ max: 250, share: .62 }}
          testId={e => (e.add ? "composer-identity-add" : e.ghostly ? "composer-identity-ghostly" : "composer-identity")} blocked={why}
          face={(e, { after }) => (e.add ? <AddIdCardFace first={mine.length === 0} providers={providers} /> : <IdCardFace card={e.card} after={after} shared={e.on} />)}
          mark={e => <IdCardMark provider={e.add ? undefined : e.card.provider} subject={e.add ? undefined : e.card.bound} />}
          tone={tone} />
        {entry.add ? <>
          <p className="composer-sheet-hint" data-testid={mine.length === 0 ? "composer-identities-empty" : undefined}>
            {mine.length === 0 ? `${t("identities.ghostly.noOthers")} ` : ""}{canAdd ? t("identities.ghostly.addHint") : "No identity can be added on this device."}
          </p>
          {canAdd && <button type="button" data-testid="composer-identities-add" className="composer-sheet-action" onClick={() => setAdding(true)}>{mine.length === 0 ? t("identities.ghostly.addOne") : t("identities.ghostly.addAnother")}<ForwardArrow /></button>}
        </> : <>
          <p className="composer-sheet-hint" data-testid="composer-identity-hint" data-blocked={blocked ? true : undefined}>
            {blocked ?? (entry.ghostly
              ? t("identities.ghostly.hintSees", { contact, name: entry.card.name ?? "", key: entry.card.short })
              : `${contact} ${entry.on ? "sees" : "will see"} ${spoken(entry.card)}, ${lower(entry.card.category)}, ${lower(entry.card.validity)}.`)}
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
    </div>)
  );
}

/**
 * The Ghostly card turned over: what the contact sees in any case (the name and picture, this chat's key in full,
 * to copy), whether they also see other identities, and "Share only this", which takes those back.
 */
function GhostlyBack({ t, card, contact, others, busy, done, error, actionRef, onShareOnly, onCards }: {
  t: Translate; card: IdCardContent; contact: string; others: number; busy: string; done: "shared" | "stopped" | "only" | null; error: string;
  actionRef: RefObject<HTMLButtonElement | null>; onShareOnly: () => void; onCards: () => void;
}) {
  const { copied, copy } = useCopyKey(card.subject);
  const working = busy === GHOSTLY;
  const state = others === 0 ? t("identities.ghostly.onlyThis", { contact }) : others === 1 ? t("identities.ghostly.alsoSeesOne", { contact }) : t("identities.ghostly.alsoSees", { contact, count: others });
  return (
    <div className="id-card-back" data-testid="composer-identity-back" data-ghostly="true">
      <div className="id-card-back-band">
        <span className="id-card-back-title">What {contact} sees</span>
        {!done && <FlipTurnButton testId="composer-identity-change-card" label="Choose another identity" onClick={onCards} />}
      </div>
      <div className="id-card-back-body">
        <div className="id-card-back-sees" data-testid="composer-identity-sees">
          {card.photo ? <img src={card.photo} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" /> : <ProviderMark provider={GHOSTLY} />}
          <span className="id-card-back-who">
            <span className="id-card-back-name">{card.label}{card.name ? ` · ${card.name}` : ""}</span>
            <span className="id-card-back-subject" title={card.subject}>{card.short}</span>
            <span className="id-card-back-meta">{card.category} · {card.validity}</span>
          </span>
        </div>
        <code className="block break-all select-all rounded-lg bg-black/30 p-2 text-[11px] leading-4 text-white/85" data-testid="composer-identity-key">{card.subject}</code>
        {/* Once done, the line saying so stands for it: the engine's state catches up a moment later. */}
        {!done && <p className="id-card-back-state"><span data-testid="composer-identity-status">{state}</span></p>}
        {done ? <p role="status" className="id-card-back-done" data-testid="composer-identity-done">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t("identities.ghostly.doneOnly")}
        </p> : <div className="flex flex-wrap gap-2">
          {/* While a call runs the button stays focusable (a disabled button would drop the keyboard's focus). */}
          {others > 0 && <button ref={actionRef} type="button" data-testid="composer-identity-share" className="composer-sheet-action flex-1"
            aria-disabled={!!busy || undefined} aria-busy={working || undefined} onClick={onShareOnly}>
            {working ? t("identities.ghostly.stopping") : <>{t("identities.ghostly.shareOnly")}<ForwardArrow /></>}
          </button>}
          <button ref={others > 0 ? undefined : actionRef} type="button" data-testid="composer-identity-copy-key" data-variant="secondary" className="composer-sheet-action flex-1" onClick={copy}>
            {copied ? t("identities.ghostly.copied") : t("identities.ghostly.copyKey")}
          </button>
        </div>}
        {error && <p role="alert" className="m-0 text-xs text-danger" data-testid="composer-identities-error">{error}</p>}
      </div>
      <span className="id-card-mrz id-card-back-mrz" aria-hidden="true">{card.mrz ?? machineLine(card.label, card.subject)}</span>
    </div>
  );
}

/**
 * The chosen identity's card, turned over: what the contact sees (its mark, the identity, who stands behind it and
 * until when), where it stands in this chat, and Share or Stop sharing. Once done, a line saying so in its place.
 */
function IdentityBack({ entry, contact, now, busy, done, error, status, actionRef, onToggle, onCards }: {
  entry: Proof; contact: string; now: number; busy: string; done: "shared" | "stopped" | "only" | null; error: string; status?: Shared;
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
        {card.lookup && <PublicProfileDetails provider={p.provider} profile={card.profile} compact testId="composer-identity-public-profile" />}
        {/* Once done, the line saying so stands for it: the engine's state catches up a moment later. */}
        {!done && <p className="id-card-back-state">
          <span data-testid="composer-identity-status" className={tone}>{state}</span>
          {warn && <span data-testid="composer-identity-expiring" className="text-amber-500"> · {warn}</span>}
        </p>}
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
