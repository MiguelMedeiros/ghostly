import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import type { NostrContactView } from "@ghostly/browser/nostr/types";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { categoryLabel, currentStatus, date, dateTime, providerLabel, providerOf, RECEIVED_STATUS, SHARED_STATUS, shortSubject, useEngineState } from "../../lib/identities";
import { Button, Notice } from "../wallet/ui";
import { NostrContactCard } from "../nostr/NostrContactCard";
import { ProviderMark, StatusPill } from "./ProviderMark";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One chat's identities: what the contact shared (checked by this app, with its category, source and
 * time), and which of this profile's identities to show this contact. Nothing is shared by default.
 */
export function ChatIdentitiesDialog({ peerKey, name, onClose }: { peerKey: string; name: string; onClose: () => void }) {
  const state = useEngineState();
  const navigate = useNavigate();
  const link: LinkView | undefined = state?.links.find(l => l.peerPubKeyZ32 === peerKey);
  const ids = link?.identities;
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(dialog, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const now = Math.floor(Date.now() / 1000);
  const act = (key: string, work: () => Promise<unknown>) => { setBusy(key); setError(""); void work().catch(e => setError(message(e))).finally(() => setBusy("")); };
  const mine = state?.identityProofs ?? [];
  const received = (ids?.received ?? []).map(r => ({ ...r, status: currentStatus(r) })).sort((a, b) => Number(b.status === "verified") - Number(a.status === "verified"));
  const connected = link?.dataLink === "open" && link.pairing?.status === "ready";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in" {...backdrop}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-identities-title" data-testid="chat-identities"
        className="focus:outline-none w-full max-w-lg max-h-[90dvh] overflow-y-auto bg-panel-header border border-border rounded-2xl shadow-2xl p-5 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="chat-identities-title" className="text-lg font-medium text-text-primary">Identities with {name}</h2>
            <p className="text-xs text-text-muted mt-1">Optional proofs of other identities, only in this chat. They never replace the keys that secure it, and do not prove who a person is.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="grid place-items-center w-10 h-10 shrink-0 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt cursor-pointer">×</button>
        </div>

        <section className="space-y-2" data-testid="chat-identities-received">
          <h3 className="text-xs font-medium text-text-muted">Shared by {name}</h3>
          {received.length === 0 ? <p className="text-xs text-text-muted" data-testid="chat-identities-none">Nothing shared by this contact.</p>
            : received.map(r => <Received key={r.id} r={r} busy={busy} act={act} linkId={link!.id} name={name} nostr={link?.nostr?.find(v => v.subject === r.subject)} />)}
        </section>

        <section className="space-y-2" data-testid="chat-identities-mine">
          <h3 className="text-xs font-medium text-text-muted">Yours, for this contact</h3>
          {!link?.identities ? <Notice>Identities can be shared in paired chats only.</Notice>
            : connected && !ids?.support ? <Notice testId="chat-identities-unsupported">{name}’s app cannot receive identities yet.</Notice> : null}
          {mine.length === 0 ? (
            <div className="flex flex-wrap items-center gap-3"><p className="flex-1 min-w-[12rem] text-xs text-text-muted">You have no identities in this profile yet.</p><Button onClick={() => { onClose(); navigate("/profile"); }}>Add in Profile</Button></div>
          ) : mine.map(p => {
            const shared = ids?.shared.find(s => s.id === p.id);
            const on = !!shared && shared.status !== "withdrawn" && shared.status !== "withdrawal-pending";
            const expired = p.expiresAt <= now;
            const contactCannot = ids?.contactProviders && !ids.contactProviders.includes(p.provider);
            return (
              <div key={p.id} data-testid="chat-identity-mine" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border p-3">
                <ProviderMark provider={p.provider} subject={p.verified.subject} />
                <div className="min-w-0 flex-[1_1_12rem]">
                  <p className="text-sm text-text-primary">{providerLabel(p.provider)} <span className="font-mono text-xs text-text-muted">{shortSubject(p.provider, p.verified.subject)}</span></p>
                  <p className="text-xs text-text-muted" data-testid="chat-identity-mine-status">{expired ? `Expired ${date(p.expiresAt)}` : shared ? SHARED_STATUS[shared.status] : "Not shared"}{shared?.status === "rejected" && shared.error ? `: ${shared.error}` : ""}</p>
                  {contactCannot && !on && <p className="text-xs text-text-muted">{name}’s app cannot verify {providerLabel(p.provider)} yet.</p>}
                </div>
                {on ? <Button data-testid="chat-identity-withdraw" disabled={!!busy} onClick={() => act(p.id, () => engine.call("withdrawIdentityProof", { linkId: link!.id, id: p.id }))}>Stop sharing</Button>
                  : <Button variant="primary" data-testid="chat-identity-share" disabled={!!busy || expired || !link?.identities || !!contactCannot || (connected && !ids?.support)}
                    onClick={() => act(p.id, () => engine.call("shareIdentityProof", { linkId: link!.id, id: p.id }))}>Share</Button>}
              </div>
            );
          })}
          {mine.length > 0 && <p className="text-[11px] text-text-muted">Sharing the same identity in several chats lets those contacts know it is you. Stopping tells {name}; a copy they kept cannot be erased.</p>}
        </section>
        {(error || ids?.error) && <Notice tone="error" testId="chat-identities-error">{error || ids?.error}</Notice>}
      </div>
    </div>
  );
}

function Received({ r, linkId, busy, act, name: contactName, nostr }: { r: ReceivedIdentityView; linkId: string; busy: string; act: (key: string, work: () => Promise<unknown>) => void; name: string; nostr?: NostrContactView }) {
  const provider = providerOf(r.provider);
  const ok = r.status === "verified";
  const name = r.display?.name ?? r.verified.display?.name;
  const avatar = r.display?.avatar ?? r.verified.display?.avatar;
  return (
    <div data-testid="chat-identity-received" data-provider={r.provider} data-status={r.status} className="rounded-xl border border-border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {avatar ? <img src={avatar} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" /> : <ProviderMark provider={r.provider} subject={r.subject} />}
        <div className="min-w-0 flex-[1_1_10rem]">
          <p className="text-sm text-text-primary">{name ?? providerLabel(r.provider)}{name && <span className="text-xs text-text-muted"> · {providerLabel(r.provider)}</span>}</p>
          {name && <p className="text-[11px] text-text-muted" data-testid="chat-identity-received-name-source">{r.display?.source ?? r.verified.display?.source}</p>}
          <p className="text-xs text-text-muted">{categoryLabel(r.provider, r.verified.attester)}</p>
        </div>
        <StatusPill ok={ok} testId="chat-identity-received-status">{RECEIVED_STATUS[r.status]}</StatusPill>
      </div>
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer py-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Details</summary>
        <div className="mt-2 space-y-2 leading-5">
          <code className="block break-all select-all bg-surface-alt rounded-lg p-2 text-[11px] text-text-primary" data-testid="chat-identity-received-subject">{r.subject}</code>
          <p>{r.verified.source}. Checked on this device {dateTime(r.verifiedAt)}{r.checkedAt !== r.verifiedAt ? `, last checked ${dateTime(r.checkedAt)}` : ""}. {r.status === "expired" ? "Expired" : "Valid until"} {date(r.expiresAt)}.</p>
          {r.status === "unconfirmed" && <p className="text-danger">Could not be confirmed on {dateTime(r.checkedAt)}{r.error ? `: ${r.error}` : ""}.</p>}
          {r.status === "revoked" && <p>Its owner removed it from their profile and published a revocation, seen {dateTime(r.checkedAt)}.</p>}
          <p>{provider?.category === "provider-attested" ? `${r.verified.attester} says this account logged in. That is only as trustworthy as ${r.verified.attester}.` : "Only the holder of this key could have made this proof."} It does not prove who a person is.</p>
          <div className="flex flex-wrap gap-2">
            {r.status !== "withdrawn" && r.status !== "revoked" && <Button data-testid="chat-identity-recheck" disabled={!!busy} onClick={() => act(r.id, () => engine.call("recheckIdentityProof", { linkId, id: r.id }))}>{busy === r.id ? "Checking…" : "Check again"}</Button>}
            {provider?.lookupDisplay && ok && <Button data-testid="chat-identity-lookup" disabled={!!busy} onClick={() => act(r.id, () => engine.call("lookupIdentityDisplay", { linkId, id: r.id }))}>{provider.lookupLabel ?? "Show public profile"}</Button>}
          </div>
          <p className="text-[11px]">“Check again” looks for a revocation by its owner{provider?.recheck ? " and repeats the check" : ""}.{provider?.lookupDisplay && ok ? " A public profile is looked up only when you ask; the servers asked learn which identity you looked up." : ""}</p>
        </div>
      </details>
      {r.provider === "nostr" && ok && nostr && <NostrContactCard linkId={linkId} view={nostr} name={contactName} />}
    </div>
  );
}
