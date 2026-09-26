import { useEffect, useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import type { NostrContactView } from "@ghostly/browser/nostr/types";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useDialogFocus } from "../../hooks/useDismiss";
import { dateTime, providerOf, useEngineState } from "../../lib/identities";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { Deck } from "../deck/Deck";
import { CardFlip, FlipTurnButton } from "../deck/Flip";
import { useCardFlip } from "../deck/useCardFlip";
import { NostrContactCard } from "../nostr/NostrContactCard";
import { useCopyKey } from "../../hooks/useCopyKey";
import { IdentityPicker } from "./ComposerIdentities";
import { contactBadges } from "./contactBadges";
import { ContactFacePicker } from "./ContactFacePicker";
import { IdCardFace, IdCardMark } from "./IdCardFace";
import { contactGhostlyCard, GHOSTLY, idCardTone, machineLine, receivedIdCard, type IdCardContent } from "./idCard";
import { ProviderMark } from "./ProviderMark";
import { PublicProfileDetails } from "./PublicProfileDetails";
import "./contact-panel.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Entry = { id: typeof GHOSTLY; ghostly: true; card: IdCardContent } | { id: string; ghostly?: false; r: ReceivedIdentityView; card: IdCardContent };
type Received = Extract<Entry, { r: ReceivedIdentityView }>;

/**
 * A chat's identities, beside the chat (the chat's column is `chat-pane`, contact-panel.css): a side panel in a wide
 * column, over the chat in a narrow one, a sheet from the bottom on a phone. The contact's identities are a deck of
 * their ID cards (the Identities page's cards, on the same deck): first their Ghostly identity, the name and picture
 * they sent and their key in this chat, then what they shared; a click turns a card over to how it was proven,
 * when this app checked it, until when it holds, and Check again. A Nostr card's back also loads the key's profile,
 * follows and notes, which asks relays. Below, which of this profile's identities the contact sees: the chat's
 * identity picker, in the panel.
 */
export function ContactIdentitiesPanel({ peerKey, name, card, onClose }: {
  peerKey: string; name: string;
  /** Opens on this card: a share tapped in the chat's timeline, theirs or mine. */
  card?: { side: "mine" | "theirs"; id: string };
  onClose: () => void;
}) {
  const state = useEngineState();
  const { t } = useI18n();
  const nav = useAppNavigation();
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ref = useRef<HTMLElement>(null), mineRef = useRef<HTMLElement>(null);
  const titleId = useId();
  // One of mine: its section comes into view, the picker on that card.
  useEffect(() => { if (card?.side === "mine") mineRef.current?.scrollIntoView({ block: "nearest" }); }, [card]);
  useDialogFocus(ref, onClose);
  const now = Math.floor(Date.now() / 1000);
  // Every identity with a mark, in the header's order (contactBadges.ts), then the ones no longer shared.
  const received = link?.identities?.received ?? [];
  const order = contactBadges(received, { now }).map(b => b.id);
  const rank = (r: ReceivedIdentityView) => { const i = order.indexOf(r.id); return i < 0 ? order.length : i; };
  const entries: Entry[] = [
    ...(link ? [{ id: GHOSTLY, ghostly: true, card: contactGhostlyCard(t, link, name) } as const] : []),
    ...[...received].sort((a, b) => rank(a) - rank(b)).map((r): Entry => ({ id: r.id, r, card: receivedIdCard(r, now) })),
  ];

  return (<>
    <div className="contact-panel-backdrop" aria-hidden="true" onClick={onClose} />
    <aside ref={ref} tabIndex={-1} role="dialog" aria-labelledby={titleId} data-testid="chat-identities" className="contact-panel focus:outline-none">
      <div className="contact-panel-head">
        <div className="min-w-0">
          <h2 id={titleId} className="contact-panel-title">Identities with {name}</h2>
          <p className="contact-panel-lead">Optional proofs, only in this chat. They do not prove who a person is.</p>
        </div>
        <button type="button" aria-label="Close" data-testid="chat-identities-close" onClick={onClose} className="contact-panel-close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="contact-panel-body">
        <ContactFacePicker peerKey={peerKey} received={received} />
        <section className="contact-panel-section" data-testid="chat-identities-received" aria-label={`Shared by ${name}`}>
          <h3 className="contact-panel-heading">Shared by {name}</h3>
          {link
            ? <TheirCards t={t} entries={entries} link={link} name={name} nostr={link.nostr ?? []} initial={card?.side === "theirs" ? card.id : undefined} />
            : <p className="contact-panel-note" data-testid="chat-identities-none">{t("identities.ghostly.nothingElse", { name })}</p>}
        </section>
        <section ref={mineRef} className="contact-panel-section" data-testid="chat-identities-mine" aria-label="Yours, for this contact">
          <h3 className="contact-panel-heading">Yours, for this contact</h3>
          {link?.identities
            ? <IdentityPicker peerKey={peerKey} contact={name} initial={card?.side === "mine" ? card.id : undefined} onManage={() => { onClose(); nav.open("/identities"); }}
              frame={({ side, tone }, children) => <div className={`contact-picker composer-identities ${tone}`} data-testid="chat-identities-picker" data-side={side}>{children}</div>} />
            : <p className="contact-panel-note">Identities can be shared in paired chats only.</p>}
        </section>
      </div>
    </aside>
  </>);
}

/** The contact's ID cards: a deck, then the chosen card turned over. */
function TheirCards({ t, entries, link, name, nostr, initial }: { t: Translate; entries: Entry[]; link: LinkView; name: string; nostr: NostrContactView[]; initial?: string }) {
  const [chosen, setChosen] = useState<string | undefined>(initial);
  const { side, flipped, turn, turnBack } = useCardFlip();
  const root = useRef<HTMLDivElement>(null);
  const entry = entries.find(e => e.id === chosen) ?? entries[0];
  const tone = (e: Entry) => idCardTone({ provider: e.card.provider, subject: e.card.bound, attested: e.card.attested });
  // Turned over, the keys go to the back's way back; face up again, to the chosen card.
  useEffect(() => {
    if (side === "back" && flipped) root.current?.querySelector<HTMLElement>("[data-testid=chat-identity-cards]")?.focus({ preventScroll: true });
  }, [side, flipped]);
  const cards = () => { turnBack(); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]')?.focus({ preventScroll: true })); };
  const showing = side === "back" ? entry : undefined;
  return (
    <div ref={root} className={`contact-cards ${tone(entry)}`} data-side={showing ? "back" : "cards"}>
      {showing ? <CardFlip className="contact-identity" flipped={flipped} tone={tone(showing)}
        front={<IdCardFace card={showing.card} />}
        back={showing.ghostly
          ? <TheirGhostlyBack t={t} card={showing.card} link={link} name={name} onCards={cards} />
          : <TheirCardBack entry={showing} linkId={link.id} name={name} nostr={nostr.find(v => v.subject === showing.r.subject)} onCards={cards} />} />
      : <>
        <Deck<Entry> compact cards={entries} selected={entry.id} onSelect={setChosen} onChoose={id => { setChosen(id); turn(); }}
          kind="radios" label={`Identities shared by ${name}`} name="contact-identity-deck" className="id-deck" size={{ max: 300, share: .78 }}
          testId={e => (e.ghostly ? "chat-identity-ghostly" : "chat-identity-received")}
          face={(e, { after }) => <IdCardFace card={e.card} after={after} />}
          mark={e => <IdCardMark provider={e.card.provider} subject={e.card.bound} />}
          tone={tone} />
        {entries.length === 1
          ? <p className="contact-panel-note" data-testid="chat-identities-none">{t("identities.ghostly.nothingElse", { name })}</p>
          : <p className="contact-panel-hint">Choose a card to see how it was checked.</p>}
      </>}
    </div>
  );
}

/**
 * The contact's Ghostly card turned over: the name and picture as they sent them (not a proof), their key in this
 * chat in full, to copy, whether it is verified (codes compared), and since when the chat exists.
 */
function TheirGhostlyBack({ t, card, link, name, onCards }: { t: Translate; card: IdCardContent; link: LinkView; name: string; onCards: () => void }) {
  const { copied, copy } = useCopyKey(card.subject);
  return (
    <div className="id-card-back contact-card-back" data-testid="chat-identity-back" data-provider={GHOSTLY} data-status={card.status}>
      <div className="id-card-back-band">
        <span className="id-card-back-title">{t("identities.ghostly.theirs")}</span>
        <FlipTurnButton testId="chat-identity-cards" label={`Back to ${name}’s cards`} onClick={onCards} />
      </div>
      <div className="id-card-back-body">
        <div className="id-card-back-sees">
          {card.photo ? <img src={card.photo} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" /> : <ProviderMark provider={GHOSTLY} />}
          <span className="id-card-back-who">
            <span className="id-card-back-name">{card.label}{card.name ? ` · ${card.name}` : ""}</span>
            <span className="id-card-back-subject" title={card.subject} data-testid="chat-identity-received-subject">{card.short}</span>
            <span className="id-card-back-meta">{card.category}</span>
          </span>
        </div>
        <code className="block break-all select-all rounded-lg bg-black/30 p-2 text-[11px] leading-4 text-white/85" data-testid="chat-identity-key">{card.subject}</code>
        <dl className="contact-card-facts">
          <dt>Name</dt>
          <dd>{t("identities.ghostly.nameAsSaid")}</dd>
          <dt>Key</dt>
          <dd data-testid="chat-identity-received-status" data-status={link.peerVerified ? "verified" : "unverified"}>{card.statusLabel}. {link.peerVerified ? t("identities.ghostly.verifiedExplain") : t("identities.ghostly.notVerifiedExplain")}</dd>
          {card.issued && <><dt>Since</dt><dd>{card.validity}</dd></>}
        </dl>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="contact-card-action" data-testid="chat-identity-copy-key" onClick={copy}>{copied ? t("identities.ghostly.copied") : t("identities.ghostly.copyKey")}</button>
        </div>
      </div>
      <span className="id-card-mrz id-card-back-mrz" aria-hidden="true">{card.mrz ?? machineLine(card.label, card.subject)}</span>
    </div>
  );
}

/**
 * A contact's card turned over: what it proves and how (their own key, or a provider that says so), when this app
 * checked it and until when it holds, Check again, and a public profile when the provider has one. A Nostr card's
 * back holds what the key published, loaded on request.
 */
function TheirCardBack({ entry, linkId, name, nostr, onCards }: { entry: Received; linkId: string; name: string; nostr?: NostrContactView; onCards: () => void }) {
  const { r, card } = entry;
  const provider = providerOf(r.provider);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const act = (key: string, work: () => Promise<unknown>) => { setBusy(key); setError(""); void work().catch(e => setError(message(e))).finally(() => setBusy("")); };
  const ok = card.status === "verified" || card.status === "expiring";
  const canCheck = r.status !== "withdrawn" && r.status !== "revoked" && r.status !== "previous-key";
  return (
    <div className="id-card-back contact-card-back" data-testid="chat-identity-back" data-provider={r.provider} data-status={card.status}>
      <div className="id-card-back-band">
        <span className="id-card-back-title">How it was checked</span>
        <FlipTurnButton testId="chat-identity-cards" label={`Back to ${name}’s cards`} onClick={onCards} />
      </div>
      <div className="id-card-back-body">
        <div className="id-card-back-sees">
          <ProviderMark provider={r.provider} subject={card.bound} />
          <span className="id-card-back-who">
            <span className="id-card-back-name">{card.label}{card.name ? ` · ${card.name}` : ""}</span>
            <span className="id-card-back-subject" title={card.subject} data-testid="chat-identity-received-subject">{card.short}</span>
            <span className="id-card-back-meta">{card.category}</span>
            {/* A name the evidence or a lookup carried, and who wrote it: a holder's own words are not a proof. */}
            {card.name && <span className="id-card-back-meta" data-testid="chat-identity-received-name-source">Name: {card.profile?.found && card.profile.name ? "their public profile" : r.display?.source ?? r.verified.display?.source}</span>}
          </span>
        </div>
        {card.lookup && <PublicProfileDetails provider={r.provider} profile={card.profile} testId="chat-identity-public-profile" />}
        <dl className="contact-card-facts">
          <dt>Proves</dt>
          <dd>{card.attested ? `${r.verified.attester ?? "The provider"} says this account logged in: only as trustworthy as ${r.verified.attester ?? "it"}.` : "Only the holder of this key could have made this proof."}</dd>
          <dt>How</dt>
          <dd>{r.verified.source}</dd>
          <dt>Checked</dt>
          <dd data-testid="chat-identity-checked">On this device {dateTime(r.verifiedAt)}{r.checkedAt !== r.verifiedAt ? `, last ${dateTime(r.checkedAt)}` : ""}</dd>
          <dt>Validity</dt>
          <dd>{card.validity}</dd>
          <dt>Status</dt>
          <dd data-testid="chat-identity-received-status" data-status={card.status}>{card.statusLabel}
            {r.status === "unconfirmed" && `: could not be confirmed${r.error ? ` (${r.error})` : ""}`}
            {r.status === "revoked" && ": its owner removed it and published a revocation"}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          {canCheck && <button type="button" className="contact-card-action" data-testid="chat-identity-recheck" aria-disabled={!!busy || undefined}
            onClick={() => { if (!busy) act("recheck", () => engine.call("recheckIdentityProof", { linkId, id: r.id })); }}>{busy === "recheck" ? "Checking…" : "Check again"}</button>}
          {provider?.lookupDisplay && ok && <button type="button" className="contact-card-action" data-testid="chat-identity-lookup" aria-disabled={!!busy || undefined}
            onClick={() => { if (!busy) act("lookup", () => engine.call("lookupIdentityDisplay", { linkId, id: r.id })); }}>{busy === "lookup" ? "Looking up…" : provider.lookupLabel ?? "Show public profile"}</button>}
        </div>
        <p className="id-card-back-note">Check again looks for a revocation by its owner{provider?.recheck ? " and repeats the check" : ""}.{provider?.lookupDisplay && ok ? " A public profile is looked up only when you ask; the servers asked learn which identity you looked up." : ""}</p>
        {error && <p role="alert" className="m-0 text-xs text-danger" data-testid="chat-identities-error">{error}</p>}
        {r.provider === "nostr" && ok && nostr && <div className="contact-card-nostr"><NostrContactCard linkId={linkId} view={nostr} name={name} compact /></div>}
      </div>
      <span className="id-card-mrz id-card-back-mrz" aria-hidden="true">{machineLine(card.label, card.subject)}</span>
    </div>
  );
}
