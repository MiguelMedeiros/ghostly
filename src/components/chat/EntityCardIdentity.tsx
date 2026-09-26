import { useCallback, useEffect, useRef, useState } from "react";
import { parseDid } from "@ghostly/core";
import { PUBKY_RELAYS, pubkyHomeserver } from "@ghostly/browser/proofs/pubky";
import { boundedIdentityFetch } from "@ghostly/browser/proofs/verify";
import { isGood, type BadgeState } from "../identities/contactBadges";
import { ProviderMark, StatusPill } from "../identities/ProviderMark";
import { providerOf, shortSubject, useEngineState } from "../../lib/identities";
import { EntityCardFrame, cardQuiet } from "./EntityCardFrame";
import { identityStanding } from "./identityStanding";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fetchForCard = boundedIdentityFetch({ online: () => globalThis.navigator?.onLine !== false });
const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

const STATE_WORDS: Record<BadgeState, string> = {
  verified: "Proved by", expiring: "Proved by", revoked: "Revoked by", failed: "Check failed for", expired: "Proof expired from",
};

/** How a subject is looked up, said before the tap, and whether it can run on this device alone. */
function lookupOf(provider: "pubky" | "did", subject: string): { offline: boolean; where: string } {
  if (provider === "pubky") return { offline: false, where: `Looking it up asks Pubky's Pkarr relays (${PUBKY_RELAYS.map(host).join(", ")}), which learn your IP address and this key.` };
  const { method, id } = parseDid(subject);
  if (method === "key" || method === "jwk") return { offline: true, where: "Checked on this device: the key is the identifier." };
  if (method === "dht") return { offline: false, where: "Looking it up asks the Pkarr relays for its record, which learn your IP address and this DID." };
  return { offline: false, where: `Looking it up asks your DNS-over-HTTPS resolver about ${id.split(":")[0].replace(/%3a/i, ":")} and downloads its did.json from there: that server learns your IP address.` };
}

type Lookup = { status: "idle" } | { status: "loading" } | { status: "ok"; facts: readonly { label: string; value: string }[] } | { status: "error"; error: string };

/**
 * A Pubky key (`pubky://…`, `pk:…`) or a DID in a message: the provider's mark, the short subject, and a badge from
 * what the chats already know (a contact's verified proof of it, or yours). Resolving it (a DID document, a Pubky
 * key's homeserver) runs on a tap, or by itself as soon as the card is visible when that needs no network
 * (did:key, did:jwk). Resolving shows what the identifier is; only a proof ties it to a person.
 */
export function IdentityEntityCard({ provider, subject, peerPubKey }: { provider: "pubky" | "did"; subject: string; peerPubKey?: string }) {
  const state = useEngineState();
  const standing = identityStanding(state, provider, subject, peerPubKey);
  const { offline, where } = lookupOf(provider, subject);
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const resolve = useCallback(async () => {
    controller.current?.abort();
    const current = controller.current = new AbortController();
    setLookup({ status: "loading" });
    try {
      let facts: readonly { label: string; value: string }[];
      if (provider === "pubky") {
        const { homeserver, endpoint } = await pubkyHomeserver(subject, fetchForCard, current.signal);
        facts = [{ label: "Homeserver", value: shortSubject("pubky", homeserver) }, { label: "Address", value: endpoint.host }];
      } else {
        const preview = providerOf("did")?.subject.preview;
        if (!preview) throw new Error("This app cannot resolve DIDs");
        facts = (await preview(subject, { signal: current.signal })).facts;
      }
      if (!current.signal.aborted) setLookup({ status: "ok", facts });
    } catch (e) { if (!current.signal.aborted) setLookup({ status: "error", error: message(e) }); }
  }, [provider, subject]);

  // Offline checks run once the card scrolls into view; anything that reaches a server waits for the tap.
  useEffect(() => {
    if (!offline || !card.current) return;
    if (typeof IntersectionObserver === "undefined") { void resolve(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { observer.disconnect(); void resolve(); }
    });
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [offline, resolve]);

  const label = provider === "pubky" ? "Pubky key" : `DID · did:${parseDid(subject).method}`;
  const badge = standing.kind === "own"
    ? <StatusPill ok testId="entity-identity-badge">{standing.label}</StatusPill>
    : standing.kind === "contact"
      ? <StatusPill ok={isGood(standing.state)} warn={standing.state === "expiring" || standing.state === "failed"} testId="entity-identity-badge">{STATE_WORDS[standing.state]} {standing.who}</StatusPill>
      : <StatusPill testId="entity-identity-badge">Not proved in your chats</StatusPill>;

  return (
    <div ref={card}>
      <EntityCardFrame testId="entity-identity" data={{ "data-provider": provider, "data-subject": subject, "data-standing": standing.kind === "contact" ? standing.state : standing.kind, "data-lookup": lookup.status }}
        label={label} mark={<ProviderMark provider={provider} subject={subject} />}
        title={<span className="font-mono text-[12.5px]" title={subject}>{shortSubject(provider, subject)}</span>}
        subtitle={badge}>
        {lookup.status === "ok" && (
          <dl data-testid="entity-identity-facts" className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {lookup.facts.map(f => <div key={f.label} className="contents">
              <dt className="text-text-primary/65">{f.label}</dt>
              <dd className={`m-0 min-w-0 [overflow-wrap:anywhere] text-text-primary ${/\s/.test(f.value) ? "" : "font-mono"}`}>{f.value}</dd>
            </div>)}
          </dl>
        )}
        {lookup.status === "error" && <p role="alert" data-testid="entity-identity-error" className="m-0 text-danger-ink">Could not resolve it: {lookup.error}</p>}
        <p className="m-0 text-[11px] text-text-primary/65" data-testid="entity-identity-where">
          {where} Resolving shows what it is, not who holds it{standing.kind === "none" ? ": a contact proves that by sharing it as an identity." : "."}
        </p>
        {!(offline && lookup.status === "ok") && (
          <button type="button" data-testid="entity-identity-resolve" disabled={lookup.status === "loading"} className={cardQuiet} onClick={() => void resolve()}>
            {lookup.status === "loading" ? "Looking it up…" : lookup.status === "idle" ? "Look it up" : "Look it up again"}
          </button>
        )}
      </EntityCardFrame>
    </div>
  );
}
