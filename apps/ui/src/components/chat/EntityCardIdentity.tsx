import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { parseDid } from "@ghostly/core";
import { PUBKY_RELAYS, pubkyHomeserver } from "@ghostly/browser/proofs/pubky";
import { boundedIdentityFetch } from "@ghostly/browser/proofs/verify";
import { isGood, type BadgeState } from "../identities/contactBadges";
import { ProviderMark, StatusPill } from "../identities/ProviderMark";
import { providerOf, shortSubject, useEngineValue } from "../../lib/identities";
import { EntityCardFrame, cardQuiet } from "./EntityCardFrame";
import { identityStanding } from "./identityStanding";
import { useT, type Translate } from "../../contexts/I18nContext";
import { problemLine } from "../../lib/problemText";
import { localProvider } from "../../lib/providerWords";
import { namesText } from "../../lib/listText";
import { fillNames } from "../../lib/fillNodes";

const fetchForCard = boundedIdentityFetch({ online: () => globalThis.navigator?.onLine !== false });
const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** The badge's words for a contact's proof of it: "Proved by ~Ana", the name its own <bdi> (in Arabic "~Bob!" read "!Bob~"). */
function stateWords(t: Translate, state: BadgeState, named: string): ReactNode {
  if (!named) return t(STATE_WORDS[state], { who: t("chat.entity.someContact") });
  return fillNames(t(STATE_WORDS[state]), { who: named });
}

const STATE_WORDS = { verified: "chat.entity.provedBy", expiring: "chat.entity.provedBy", revoked: "chat.entity.revokedBy", failed: "chat.entity.checkFailed", expired: "chat.entity.proofExpired" } as const satisfies Record<BadgeState, string>;

/**
 * How a subject is looked up, said before the tap, and whether it can run on this device alone. `hidden`: none at all,
 * a did:web someone else chose with Hide my IP on (its server would learn this device's address, as a contact's
 * picture link's would). The other lookups ask only this device or fixed relays.
 */
function lookupOf(t: Translate, provider: "pubky" | "did", subject: string, hideIp: boolean): { offline: boolean; hidden?: boolean; where: ReactNode } {
  if (provider === "pubky") return { offline: false, where: t("chat.entity.lookupPubky", { relays: namesText(PUBKY_RELAYS.map(host), t) }) };
  const { method, id } = parseDid(subject);
  if (method === "key" || method === "jwk") return { offline: true, where: t("chat.entity.lookupLocal") };
  if (method === "dht") return { offline: false, where: t("chat.entity.lookupDht") };
  const server = id.split(":")[0].replace(/%3a/gi, ":");
  // The host its writer chose, its own <bdi> as the badge's name: a port or a dot at its edge stays on its side in Arabic.
  if (hideIp) return { offline: false, hidden: true, where: fillNames(t("chat.entity.lookupWebHiddenIp"), { host: server }) };
  return { offline: false, where: fillNames(t("chat.entity.lookupWeb"), { host: server }) };
}

type Lookup = { status: "idle" } | { status: "loading" } | { status: "ok"; facts: readonly { label: string; value: string }[] } | { status: "error"; error: string };

/**
 * A Pubky key (`pubky://…`, `pk:…`) or a DID in a message: the provider's mark, the short subject, and a badge from
 * what the chats already know (a contact's verified proof of it, or yours). Resolving it (a DID document, a Pubky
 * key's homeserver) runs on a tap, or by itself as soon as the card is visible when that needs no network
 * (did:key, did:jwk). Resolving shows what the identifier is; only a proof ties it to a person. `othersChoice`: someone
 * else wrote it (a contact's message, or one I forwarded), so Hide my IP keeps its did:web server uncontacted.
 */
export function IdentityEntityCard({ provider, subject, peerPubKey, othersChoice }: { provider: "pubky" | "did"; subject: string; peerPubKey?: string; othersChoice: boolean }) {
  // Its badge only: the engine sends its whole state anew on every change.
  const standing = useEngineValue(state => identityStanding(state, provider, subject, peerPubKey));
  const t = useT();
  const relayOnly = useEngineValue(state => state?.settings.relayOnly === true);
  const { offline, hidden, where } = lookupOf(t, provider, subject, relayOnly && othersChoice);
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
        facts = [{ label: t("chat.entity.homeserver"), value: shortSubject("pubky", homeserver) }, { label: t("chat.entity.address"), value: endpoint.host }];
      } else {
        // In the app's language, as the Identities page says it: the provider's own words are English.
        const did = providerOf("did");
        const preview = did && localProvider(did, t).subject.preview;
        if (!preview) throw new Error(t("chat.entity.noDids"));
        facts = (await preview(subject, { signal: current.signal })).facts;
      }
      if (!current.signal.aborted) setLookup({ status: "ok", facts });
    } catch (e) { if (!current.signal.aborted) setLookup({ status: "error", error: problemLine(e, t) }); }
  }, [provider, subject, t]);

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

  const label = provider === "pubky" ? t("chat.entity.pubkyKey") : `DID · did:${parseDid(subject).method}`;
  const badge = standing.kind === "own"
    ? <StatusPill ok testId="entity-identity-badge">{standing.of === "did" ? t("chat.entity.yourDid") : t("chat.entity.yourIdentity")}</StatusPill>
    : standing.kind === "contact"
      ? <StatusPill ok={isGood(standing.state)} warn={standing.state === "expiring" || standing.state === "failed"} testId="entity-identity-badge">{stateWords(t, standing.state, standing.who)}</StatusPill>
      : <StatusPill testId="entity-identity-badge">{t("chat.entity.notProved")}</StatusPill>;

  return (
    <div ref={card}>
      <EntityCardFrame testId="entity-identity" data={{ "data-provider": provider, "data-subject": subject, "data-standing": standing.kind === "contact" ? standing.state : standing.kind, "data-lookup": lookup.status }}
        label={label} mark={<ProviderMark provider={provider} subject={subject} />}
        title={<span className="font-mono chat-text-card-mono" title={subject}>{shortSubject(provider, subject)}</span>}
        subtitle={badge}>
        {lookup.status === "ok" && (
          <dl data-testid="entity-identity-facts" className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {lookup.facts.map(f => <div key={f.label} className="contents">
              <dt className="text-text-primary/65">{f.label}</dt>
              <dd className={`m-0 min-w-0 [overflow-wrap:anywhere] text-text-primary ${/\s/.test(f.value) ? "" : "font-mono"}`}>{f.value}</dd>
            </div>)}
          </dl>
        )}
        {lookup.status === "error" && <p role="alert" data-testid="entity-identity-error" className="m-0 text-danger-ink">{t("chat.entity.resolveFailed", { error: lookup.error })}</p>}
        <p className="m-0 chat-text-card-label text-text-primary/65" data-testid="entity-identity-where">
          {where} {standing.kind === "none" ? t("chat.entity.resolveNoteNone") : t("chat.entity.resolveNote")}
        </p>
        {!hidden && !(offline && lookup.status === "ok") && (
          <button type="button" data-testid="entity-identity-resolve" disabled={lookup.status === "loading"} className={cardQuiet} onClick={() => void resolve()}>
            {lookup.status === "loading" ? t("chat.entity.lookingUp") : lookup.status === "idle" ? t("chat.entity.lookUp") : t("chat.entity.lookUpAgain")}
          </button>
        )}
      </EntityCardFrame>
    </div>
  );
}
