import { useEffect, useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { ReceivedIdentityView } from "@ghostly/browser/shared/types";
import type { NostrContactView } from "@ghostly/browser/nostr/types";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useDialogFocus } from "../../hooks/useDismiss";
import { dateTime, providerOf, useEngineState } from "../../lib/identities";
import { Deck } from "../deck/Deck";
import { CardFlip, FlipTurnButton } from "../deck/Flip";
import { useCardFlip } from "../deck/useCardFlip";
import { NostrContactCard } from "../nostr/NostrContactCard";
import { IdentityPicker } from "./ComposerIdentities";
import { contactBadges } from "./contactBadges";
import { IdCardFace, IdCardMark } from "./IdCardFace";
import { idCardTone, machineLine, receivedIdCard, type IdCardContent } from "./idCard";
import { ProviderMark } from "./ProviderMark";
import "./contact-panel.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Entry = { id: string; r: ReceivedIdentityView; card: IdCardContent };

/**
 * A chat's identities, beside the chat (the chat's column is `chat-pane`, contact-panel.css): a side panel in a wide
 * column, over the chat in a narrow one, a sheet from the bottom on a phone. What the contact shared is a deck of
 * their ID cards (the Identities page's cards, on the same deck); a click turns a card over to how it was proven,
 * when this app checked it, until when it holds, and Check again. A Nostr card's back also loads the key's profile,
 * follows and notes, which asks relays. Below, which of this profile's identities the contact sees: the chat's
 * identity picker, in the panel.
 */
export function ContactIdentitiesPanel({ peerKey, name, onClose }: { peerKey: string; name: string; onClose: () => void }) {
  const state = useEngineState();
  const nav = useAppNavigation();
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(ref, onClose);
  const now = Math.floor(Date.now() / 1000);
  // Every identity with a mark, in the header's order (contactBadges.ts), then the ones no longer shared.
  const received = link?.identities?.received ?? [];
  const order = contactBadges(received, { now }).map(b => b.id);
  const rank = (r: ReceivedIdentityView) => { const i = order.indexOf(r.id); return i < 0 ? order.length : i; };
  const entries: Entry[] = [...received].sort((a, b) => rank(a) - rank(b)).map(r => ({ id: r.id, r, card: receivedIdCard(r, now) }));

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
        <section className="contact-panel-section" data-testid="chat-identities-received" aria-label={`Shared by ${name}`}>
          <h3 className="contact-panel-heading">Shared by {name}</h3>
          {entries.length === 0
            ? <p className="contact-panel-note" data-testid="chat-identities-none">Nothing shared by {name} yet.</p>
            : link && <TheirCards entries={entries} linkId={link.id} name={name} nostr={link.nostr ?? []} />}
        </section>
        <section className="contact-panel-section" data-testid="chat-identities-mine" aria-label="Yours, for this contact">
          <h3 className="contact-panel-heading">Yours, for this contact</h3>
          {link?.identities
            ? <IdentityPicker peerKey={peerKey} contact={name} onManage={() => { onClose(); nav.open("/identities"); }}
              frame={({ side, tone }, children) => <div className={`contact-picker composer-identities ${tone}`} data-testid="chat-identities-picker" data-side={side}>{children}</div>} />
            : <p className="contact-panel-note">Identities can be shared in paired chats only.</p>}
        </section>
      </div>
    </aside>
  </>);
}

/** The contact's ID cards: a deck, then the chosen card turned over. */
function TheirCards({ entries, linkId, name, nostr }: { entries: Entry[]; linkId: string; name: string; nostr: NostrContactView[] }) {
  const [chosen, setChosen] = useState<string>();
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
        back={<TheirCardBack entry={showing} linkId={linkId} name={name} nostr={nostr.find(v => v.subject === showing.r.subject)} onCards={cards} />} />
      : <>
        <Deck<Entry> compact cards={entries} selected={entry.id} onSelect={setChosen} onChoose={id => { setChosen(id); turn(); }}
          kind="radios" label={`Identities shared by ${name}`} name="contact-identity-deck" className="id-deck" size={{ max: 300, share: .78 }}
          testId={() => "chat-identity-received"}
          face={(e, { after }) => <IdCardFace card={e.card} after={after} />}
          mark={e => <IdCardMark provider={e.card.provider} subject={e.card.bound} />}
          tone={tone} />
        <p className="contact-panel-hint">Choose a card to see how it was checked.</p>
      </>}
    </div>
  );
}

/**
 * A contact's card turned over: what it proves and how (their own key, or a provider that says so), when this app
 * checked it and until when it holds, Check again, and a public profile when the provider has one. A Nostr card's
 * back holds what the key published, loaded on request.
 */
function TheirCardBack({ entry, linkId, name, nostr, onCards }: { entry: Entry; linkId: string; name: string; nostr?: NostrContactView; onCards: () => void }) {
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
          </span>
        </div>
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
