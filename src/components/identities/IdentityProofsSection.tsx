import { useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { IdentityProofView, LinkView } from "@ghostly/browser/shared/types";
import type { ApprovalRequest } from "@ghostly/browser/proofs/contract";
import { Block, Button, Notice, Row } from "../wallet/ui";
import { Deck } from "../deck/Deck";
import { addableProviders, chatsByPeer, contactName, profileSince, providerOf, SHARED_STATUS, useEngineState, useNewProof } from "../../lib/identities";
import { contactTag } from "../../lib/publicKeyLabel";
import { chatPath } from "../../lib/url";
import type { ChatSession } from "../../lib/types";
import { useI18n } from "../../contexts/I18nContext";
import { AddIdentityDialog } from "./AddIdentityDialog";
import { AddIdCardFace, IdCardFace, IdCardMark } from "./IdCardFace";
import { GHOSTLY, ghostlyCard, idCard, idCardTone, type IdCardContent } from "./idCard";
import { ProviderMark, StatusPill } from "./ProviderMark";
import { PublicDid } from "./PublicDid";
import { ApprovalPanel } from "./ApprovalPanel";
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
  /** What taking the proof down on its server is doing (an AT Protocol record), and whether it failed. */
  const [removal, setRemoval] = useState<{ progress?: string; failed?: string }>({});
  const removeAbort = useRef<AbortController | null>(null);
  /** The proof whose published part is being taken down (not revoking yet), and the approval it waits for (Pubky). */
  const [takingDown, setTakingDown] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

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
  const select = (id: string) => { removeAbort.current?.abort(); setChosen(id); setRemoving(null); setError(""); setRemoval({}); };
  const act = (key: string, work: () => Promise<unknown>) => { setBusy(key); setError(""); void work().catch(e => setError(message(e))).finally(() => setBusy("")); };
  /**
   * Removes a proof: first what its provider published, when it can take that down (an AT Protocol record, after a
   * fresh approval on the person's server), then the proof itself, which withdraws it and publishes the revocation.
   * Called straight from the click: the provider may open a window. `withRecord` false skips the first step.
   */
  const remove = (p: IdentityProofView, withRecord = true) => {
    const unpublish = withRecord ? providerOf(p.provider)?.unpublish : undefined;
    const controller = new AbortController(); removeAbort.current = controller;
    // The card says it is revoking once that starts: while an approval is awaited, nothing is revoked yet.
    if (unpublish) setTakingDown(p.id); else setRevoking(p.id);
    setError(""); setRemoval({});
    const takenDown = unpublish
      ? unpublish.run({ id: p.id, subject: p.subject, key: p.key, evidence: p.evidence }, {
        values: {}, signal: controller.signal, onAuthUrl: () => {}, onProgress: progress => setRemoval({ progress }),
        onApproval: request => { if (!controller.signal.aborted) setApproval(request); },
      }).catch((e: unknown) => { setRemoval({ failed: p.id }); throw e; })
      : Promise.resolve();
    void takenDown.then(() => { setTakingDown(null); setApproval(null); setRevoking(p.id); return engine.call("removeIdentityProof", { id: p.id }); })
      .then(() => setRemoving(null), e => { if (!controller.signal.aborted) setError(message(e)); })
      .finally(() => { setRevoking(null); setTakingDown(null); setApproval(null); setRemoval(r => ({ failed: r.failed })); });
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
            <PublicDid state={state} />
          </div>
        ) : (() => {
          const { proof: p, card } = entry;
          const busyHere = revoking === p.id || takingDown === p.id;
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
                <Button variant="danger" data-testid="identity-proof-remove-confirm" disabled={busyHere} onClick={() => remove(p)}>{revoking === p.id ? "Revoking…" : takingDown === p.id ? "Waiting…" : "Remove and stop sharing"}</Button>
                {removal.failed === p.id && !busyHere && <Button data-testid="identity-proof-remove-anyway" onClick={() => remove(p, false)}>Remove without it</Button>}
                <Button disabled={revoking === p.id} onClick={() => { removeAbort.current?.abort(); setRemoving(null); setRemoval({}); }}>Keep</Button>
              </> : <Button data-testid="identity-proof-remove" onClick={() => setRemoving(p.id)}>Remove</Button>}
            </Row>
            {removing === p.id && <Block testId="identity-proof-remove-notes"><Notice>Contacts you shared it with are told it is no longer shared, and a revocation is published so they can see it even if you never reconnect. A copy they kept cannot be erased.{providerOf(p.provider)?.unpublish ? ` ${providerOf(p.provider)!.unpublish!.description}` : ""}</Notice>
              {approval && takingDown === p.id && <ApprovalPanel request={approval} onCancel={() => removeAbort.current?.abort()} />}
              {removal.progress && busyHere && <Notice testId="identity-proof-remove-progress">{removal.progress}</Notice>}
              {removal.failed === p.id && !busyHere && <p className="text-xs text-text-muted">What it published could not be taken down. You can remove the proof without it: contacts still see it revoked.</p>}
            </Block>}
          </>;
        })()}
        {error && <Block><Notice tone="error">{error}</Notice></Block>}
      </div>
    </section>
    {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
  </>);
}
