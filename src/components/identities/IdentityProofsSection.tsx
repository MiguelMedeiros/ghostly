import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import { Block, Button, Notice, Row } from "../wallet/ui";
import { Deck } from "../deck/Deck";
import { addableProviders, chatsByPeer, contactName, profileSince, SHARED_STATUS, useEngineState, useNewProof } from "../../lib/identities";
import { contactTag } from "../../lib/publicKeyLabel";
import { chatPath } from "../../lib/url";
import type { ChatSession } from "../../lib/types";
import { useI18n } from "../../contexts/I18nContext";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace, IdCardMark } from "./IdCardFace";
import { GHOSTLY, ghostlyCard, idCard, idCardTone, type IdCardContent } from "./idCard";
import { ProviderMark, StatusPill } from "./ProviderMark";
import { useAppNavigation } from "../../hooks/useAppNavigation";

/** The last card: a blank one that adds an identity. */
const ADD = "add";
type Entry =
  | { id: typeof GHOSTLY; ghostly: true; add?: false; card: IdCardContent }
  | { id: string; ghostly?: false; add?: false; proof: IdentityProofView; card: IdCardContent }
  | { id: typeof ADD; ghostly?: false; add: true };
const PANEL = { id: "identity-panel", tabId: (id: string) => `identity-tab-${id}` };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Identities → Yours: a deck of ID cards (the wallet's deck, with ID cards for faces). The first card is the
 * profile's own Ghostly identity, what contacts see by default: its name and picture, and a key pair made for
 * each chat. Then this profile's proofs of other identities, and last the blank card that adds one. Below the
 * deck, the chosen card's details: for the Ghostly card, what it is and where its name and picture are edited;
 * for a proof, what it proves and how, the chats it is shared in, and removing it. Made once here; each chat
 * then shares them with that contact only when the person chooses (the chat's Identities).
 */
export function IdentityProofsSection() {
  const state = useEngineState();
  const { t } = useI18n();
  const nav = useAppNavigation();
  const proofs = state?.identityProofs ?? [];
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const [removing, setRemoving] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // A proof just added comes up, so the person sees what they made.
  useNewProof(state, setChosen);

  if (!state) return null;
  const now = Math.floor(Date.now() / 1000);
  const providers = addableProviders().map(p => p.id);
  const canAdd = providers.length > 0;
  const chats = state.links.some(l => l.identities?.shared.length) ? chatsByPeer() : new Map<string, ChatSession>();
  const nameOf = (link: LinkView) => contactName(chats.get(link.peerPubKeyZ32)) ?? t("common.unnamedContact", { key: contactTag(link.peerPubKeyZ32) });
  /** Contacts whose app checked this proof and refused it. */
  const refusedBy = (id: string) => state.links.filter(l => l.identities?.shared.some(s => s.id === id && s.status === "rejected")).map(nameOf);
  // Every chat has a key pair of its own (a legacy one too), so the Ghostly identity is used in every chat.
  const ghostly = ghostlyCard(t, { nick: state.settings.nick, avatar: state.settings.avatar, shareProfile: state.settings.shareProfile !== false },
    { chats: state.links.length, since: profileSince(state.links) });

  const entries: Entry[] = [
    { id: GHOSTLY, ghostly: true, card: ghostly },
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
  const tone = (e: Entry) => (e.add ? "id-card-add" : idCardTone({ provider: e.card.provider, subject: e.card.bound, attested: e.card.attested }));

  return (<>
    <section className="space-y-3" data-testid="identities-mine">
      <h2 className="text-sm font-semibold text-accent uppercase tracking-wide">Yours</h2>
      <Deck<Entry> cards={entries} selected={entry.id} onSelect={select} onChoose={id => { if (id === ADD) setAdding(true); }}
        kind="tabs" panel={PANEL} label="Your identities" name="identity-deck" className="id-deck"
        testId={e => (e.add ? "identity-add" : e.ghostly ? "identity-ghostly" : "identity-proof")}
        face={(e, { after }) => (e.add ? <AddIdCardFace first={proofs.length === 0} providers={providers} /> : <IdCardFace card={e.card} after={after} />)}
        mark={e => <IdCardMark provider={e.add ? undefined : e.card.provider} subject={e.add ? undefined : e.card.bound} />} tone={tone} />
      <div role="tabpanel" id={PANEL.id} aria-labelledby={PANEL.tabId(entry.id)} data-testid="identity-panel" className="bg-surface rounded-xl divide-y divide-border">
        {entry.add ? (
          <Block>
            <p className="text-xs text-text-muted">{t("identities.ghostly.addHint")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex flex-wrap gap-1" aria-hidden="true">{providers.map(p => <ProviderMark key={p} provider={p} small />)}</span>
              <Button variant="primary" data-testid="identity-add-open" onClick={() => setAdding(true)}>{proofs.length ? t("identities.ghostly.addAnother") : t("identities.ghostly.addOne")}</Button>
            </div>
          </Block>
        ) : entry.ghostly ? (
          <div data-testid="identity-ghostly-panel" className="divide-y divide-border">
            <Row leading={<ProviderMark provider={GHOSTLY} />}
              label={<span className="flex flex-wrap items-center gap-2"><span data-testid="identity-ghostly-name">{ghostly.name}</span>
                <StatusPill ok testId="identity-panel-status">{ghostly.statusLabel}</StatusPill></span>}
              hint={<>{ghostly.category}<span className="block">{ghostly.shared}{ghostly.issued ? ` · ${ghostly.validity}` : ""}</span></>} />
            <Block>
              <p className="text-xs text-text-muted leading-5">{t("identities.ghostly.explain")} {t("identities.ghostly.keysHint")}</p>
              {!canAdd && <p className="text-xs text-text-muted">No identity can be added on this device.</p>}
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="identity-ghostly-edit" onClick={() => nav.open("/profile")}>{t("identities.ghostly.editProfile")}</Button>
              </div>
            </Block>
          </div>
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
                    {chat && <Button onClick={() => nav.conversation(chatPath(chat.id))}>Open chat</Button>}
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
    </section>
    {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
  </>);
}
