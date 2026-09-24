import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { Block, Button, Notice, Row } from "../wallet/ui";
import { Deck } from "../deck/Deck";
import { addableProviders, chatsByPeer, contactName, SHARED_STATUS, useEngineState } from "../../lib/identities";
import { chatPath } from "../../lib/url";
import type { ChatSession } from "../../lib/types";
import { useI18n } from "../../contexts/I18nContext";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace } from "./IdCardFace";
import { idCard, idCardTone, type IdCardContent } from "./idCard";
import { providerIcon } from "./ProviderIcons";
import { ProviderMark, StatusPill } from "./ProviderMark";

/** The last card: a blank one that adds an identity. */
const ADD = "add";
type Entry = { id: string; add?: false; proof: IdentityProofView; card: IdCardContent } | { id: typeof ADD; add: true };
const PANEL = { id: "identity-panel", tabId: (id: string) => `identity-tab-${id}` };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A card's provider on a 14px tile, for the row of marks under the deck. */
function MiniMark({ entry }: { entry: Entry }) {
  if (entry.add) return <span className="id-deck-mark id-deck-mark-plain"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg></span>;
  const icon = providerIcon(entry.proof.provider, entry.card.bound);
  if (!icon) return <span className="id-deck-mark id-deck-mark-plain"><svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4" /></svg></span>;
  return <span className={`id-deck-mark forced-color-adjust-none ${icon.tile}`}>{icon.mark(10)}</span>;
}

/**
 * Identities → Yours: this profile's proofs of other identities as a deck of ID cards (the wallet's deck, with
 * ID cards for faces), the blank card that adds one at the end, and the chosen card's details below: what it
 * proves and how, the chats it is shared in, and removing it. Made once here; each chat then shares them with
 * that contact only when the person chooses (the chat's Identities).
 */
export function IdentityProofsSection() {
  const state = useEngineState();
  const { t } = useI18n();
  const navigate = useNavigate();
  const proofs = state?.identityProofs ?? [];
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const [removing, setRemoving] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // A proof just added comes up, so the person sees what they made.
  const ids = state ? proofs.map(p => p.id).join(" ") : null;
  const known = useRef<string[] | null>(null);
  useEffect(() => {
    if (ids === null) return;
    const now = ids ? ids.split(" ") : [];
    const fresh = known.current && now.find(id => !known.current!.includes(id));
    if (fresh) setChosen(fresh);
    known.current = now;
  }, [ids]);

  if (!state) return null;
  const now = Math.floor(Date.now() / 1000);
  const canAdd = addableProviders().length > 0;
  const chats = state.links.some(l => l.identities?.shared.length) ? chatsByPeer() : new Map<string, ChatSession>();
  const nameOf = (link: LinkView) => contactName(chats.get(link.peerPubKeyZ32)) ?? t("common.anonymous");
  /** Contacts whose app checked this proof and refused it. */
  const refusedBy = (id: string) => state.links.filter(l => l.identities?.shared.some(s => s.id === id && s.status === "rejected")).map(nameOf);

  const entries: Entry[] = [
    ...proofs.map((proof): Entry => ({ id: proof.id, proof, card: idCard(proof, { now, refusedBy: refusedBy(proof.id), revoking: revoking === proof.id }) })),
    ...(canAdd ? [{ id: ADD, add: true } as const] : []),
  ];
  const entry = entries.find(e => e.id === chosen) ?? entries[0];
  const select = (id: string) => { setChosen(id); setRemoving(null); setError(""); };
  const act = (key: string, work: () => Promise<unknown>) => { setBusy(key); setError(""); void work().catch(e => setError(message(e))).finally(() => setBusy("")); };
  const remove = (id: string) => {
    setRevoking(id); setError("");
    void engine.call("removeIdentityProof", { id }).then(() => setRemoving(null), e => setError(message(e))).finally(() => setRevoking(null));
  };

  return (<>
    <section className="space-y-3" data-testid="identities-mine">
      <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">Yours</h2>
      {!entry ? <p className="text-xs text-text-muted">No identity can be added on this device.</p> : <>
        <Deck<Entry> cards={entries} selected={entry.id} onSelect={select} onChoose={id => { if (id === ADD) setAdding(true); }}
          kind="tabs" panel={PANEL} label="Your identities" name="identity-deck" className="id-deck" hoverDelay={90}
          testId={e => (e.add ? "identity-add" : "identity-proof")}
          face={(e, { after }) => (e.add ? <AddIdCardFace first={proofs.length === 0} /> : <IdCardFace card={e.card} after={after} />)}
          mark={e => <MiniMark entry={e} />} tone={e => (e.add ? "id-card-add" : idCardTone({ provider: e.card.provider, subject: e.card.bound, attested: e.card.attested }))} />
        <div role="tabpanel" id={PANEL.id} aria-labelledby={PANEL.tabId(entry.id)} data-testid="identity-panel" className="bg-surface rounded-xl divide-y divide-border">
          {entry.add ? (
            <Block>
              <p className="text-xs text-text-muted">Prove that you hold a Nostr key or another identity, then show it to the contacts you choose, one chat at a time. Your Ghostly identity stays the default.</p>
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex flex-wrap gap-1" aria-hidden="true">{addableProviders().map(p => <ProviderMark key={p.id} provider={p.id} small />)}</span>
                <Button variant="primary" data-testid="identity-add-open" onClick={() => setAdding(true)}>{proofs.length ? "Add an identity" : "Add your first identity"}</Button>
              </div>
            </Block>
          ) : (() => {
            const { proof: p, card } = entry;
            const sharedIn = state.links.flatMap(link => {
              const s = link.identities?.shared.find(x => x.id === p.id && x.status !== "withdrawn");
              return s ? [{ link, status: s.status, chat: chats.get(link.peerPubKeyZ32) }] : [];
            });
            return <>
              <Row leading={<ProviderMark provider={p.provider} subject={card.bound} />}
                label={<span className="flex flex-wrap items-center gap-2"><span>{card.label}</span>
                  <StatusPill ok={card.status === "verified"} warn={card.status === "expiring"} testId="identity-panel-status">{card.statusLabel}</StatusPill></span>}
                hint={<>{card.category}<span className="block">Issued {card.issued} · {card.validity}</span></>} />
              <Block>
                <code className="block break-all select-all bg-surface-alt rounded-lg p-2 text-[11px] text-text-primary" data-testid="identity-panel-subject">{card.subject}</code>
                <p className="text-xs text-text-muted leading-5">
                  {p.verified.source}. {card.attested ? `${p.verified.attester ?? "The provider"} says this account logged in: that is only as trustworthy as ${p.verified.attester ?? "the provider"}.` : "Only the holder of this key could have made this proof."} Checked when it was made, the way your contacts check it. It does not prove who a person is.
                </p>
                {card.refusedBy.length > 0 && <p className="text-xs text-danger" data-testid="identity-proof-refused">Not verified by {card.refusedBy.join(", ")}</p>}
                {(card.status === "expired" || card.status === "expiring") && (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="flex-1 min-w-[12rem] text-xs text-text-muted">Add it again to renew it; then remove this one.</p>
                    {canAdd && <Button data-testid="identity-renew" onClick={() => setAdding(true)}>Add it again</Button>}
                  </div>
                )}
              </Block>
              <Block testId="identity-panel-sharing">
                <p className="text-xs font-medium text-text-secondary">{card.shared}</p>
                {sharedIn.length === 0 ? <p className="text-xs text-text-muted">Share it from a chat’s Identities, one contact at a time.</p>
                  : sharedIn.map(({ link, status, chat }) => (
                    <div key={link.id} data-testid="identity-shared-chat" className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <p className="flex-[1_1_10rem] min-w-0 text-sm text-text-primary">{nameOf(link)} <span className="text-xs text-text-muted">· {SHARED_STATUS[status]}</span></p>
                      {chat && <Button onClick={() => navigate(chatPath(chat.id))}>Open chat</Button>}
                      {status !== "withdrawal-pending" && <Button data-testid="identity-shared-stop" disabled={!!busy} onClick={() => act(link.id, () => engine.call("withdrawIdentityProof", { linkId: link.id, id: p.id }))}>Stop sharing</Button>}
                    </div>
                  ))}
              </Block>
              <Row label="Remove" hint="Stops sharing it everywhere and publishes a revocation.">
                {removing === p.id ? <>
                  <Button variant="danger" data-testid="identity-proof-remove-confirm" disabled={revoking === p.id} onClick={() => remove(p.id)}>{revoking === p.id ? "Revoking…" : "Remove and stop sharing"}</Button>
                  <Button disabled={revoking === p.id} onClick={() => setRemoving(null)}>Keep</Button>
                </> : <Button data-testid="identity-proof-remove" onClick={() => setRemoving(p.id)}>Remove</Button>}
              </Row>
              {removing === p.id && <Block><Notice>Contacts you shared it with are told it is no longer shared, and a revocation is published so they can see it even if you never reconnect. A copy they kept cannot be erased.</Notice></Block>}
            </>;
          })()}
          {error && <Block><Notice tone="error">{error}</Notice></Block>}
        </div>
      </>}
    </section>
    {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
  </>);
}
