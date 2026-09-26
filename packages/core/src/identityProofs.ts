import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { identityFromSeed, publicKeyFromZ32, sign, verify } from "./identity";

/**
 * Identity proofs (WISP 300), provider-agnostic half.
 *
 * A proof is made once per profile: the external identity (a Nostr key, a domain, an SSH key, an
 * OpenID Connect account…) signs or attests the canonical **statement** below, which authorizes a
 * fresh Ed25519 **proof key** that only this profile holds. Sharing it with a contact is then a
 * challenge-response on that contact's authenticated paired channel: the contact sends a fresh nonce,
 * the proof key signs a **presentation** binding the proof to both participation keys, the
 * conversation, the session and that nonce. A copy replayed to anyone else fails: wrong audience,
 * unknown nonce, and nobody else has the proof key.
 *
 * Providers (browser side, `packages/browser/src/proofs/`) only know how to produce and check the
 * evidence over the statement bytes; everything here is shared, so every provider signs the same bytes.
 */

export const IDENTITY_PROOF_CAPABILITY = "identity-proof/1";
/** Domain separation: the first words of every statement. */
export const IDENTITY_STATEMENT_PREFIX = "Ghostly identity proof v1";
/** No binding is valid for longer than this, whatever the provider allows. */
export const IDENTITY_MAX_VALIDITY = 400 * 86_400;
/** A binding issued this far in the future is refused (seconds of clock disagreement tolerated). */
export const IDENTITY_CLOCK_SKEW = 300;
/** A contact's challenge must be answered within this many seconds. */
export const IDENTITY_CHALLENGE_WINDOW = 300;
/** Evidence, serialized as JSON, is at most this many characters. */
export const IDENTITY_MAX_EVIDENCE = 16 * 1024;
/** A whole `idp-*` frame, serialized. */
export const IDENTITY_MAX_FRAME = 32 * 1024;
/** Unanswered challenges a verifier keeps per conversation. */
const MAX_CHALLENGES = 8;

export const IDENTITY_PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Printable ASCII without spaces, so the statement can be built but never needs parsing. */
export const IDENTITY_SUBJECT = /^[\x21-\x7e]{1,512}$/;
const KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const BINDING_NONCE = /^[A-Za-z0-9_-]{22}$/;
const CHALLENGE_NONCE = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;

/** What the external identity signs, as fields. `key` is the proof key (z-base-32 Ed25519). */
export interface IdentityBinding {
  v: 1;
  provider: string;
  subject: string;
  key: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** A binding with its exact bytes. Providers sign `text` (UTF-8 `bytes`) and never rebuild it. */
export interface IdentityStatement {
  binding: IdentityBinding;
  text: string;
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex: the proof's id everywhere (storage, frames, OIDC nonce input). */
  id: string;
}

/** What a provider's `verify` established. Stored by the verifier with the evidence. */
export interface VerifiedIdentity {
  /** The identity that was proven, canonical. Self-custodied providers: exactly `binding.subject`. */
  subject: string;
  /** How it was checked, for people: "Nostr signature (BIP-340)", "ID token signed by accounts.google.com". */
  source: string;
  /** Provider-attested only: who vouches for `subject` (an issuer host). */
  attester?: string;
  /** Earlier than the binding's own expiry when the evidence says so (a key or certificate expiring). */
  expiresAt?: number;
  /** Optional name/picture carried by the evidence itself, with where it came from. */
  display?: IdentityDisplay;
}

export interface IdentityDisplay {
  name?: string;
  /** A sanitized `data:image/…` URL, never a remote one. */
  avatar?: string;
  /** Where the person can see the identity (a profile page), https only. */
  url?: string;
  /** Where name/picture came from: "Nostr kind-0 metadata (self-described)". */
  source: string;
  fetchedAt: number;
}

export interface IdentityScope { subject: string; audience: string; context: string; session: string }

/**
 * Early revocation: the proof key publishes, under its own Pkarr key, a TXT record naming the proof it
 * revokes. Anyone holding a copy can look it up by the key in the binding; nothing else is published,
 * and the key is random, so the record says nothing about the identity or its contacts.
 */
export const IDENTITY_REVOCATION_LABEL = "_ghostly-revoked";
export const identityRevocationValue = (id: string, at: number) => `v=1;id=${id};at=${at}`;
/** True when these records (resolved and signature-checked under the proof key) revoke proof `id`. */
export function revokesIdentity(records: { label: string; value: string }[], id: string): boolean {
  return records.some(r => r.label === IDENTITY_REVOCATION_LABEL && new RegExp(`^v=1;id=${id};at=\\d{1,12}$`).test(r.value));
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

export function isIdentityBinding(value: unknown): value is IdentityBinding {
  const b = value as IdentityBinding;
  return !!b && typeof b === "object" && !Array.isArray(b) &&
    Object.keys(b).sort().join(",") === "expiresAt,issuedAt,key,nonce,provider,subject,v" && b.v === 1 &&
    typeof b.provider === "string" && IDENTITY_PROVIDER_ID.test(b.provider) &&
    typeof b.subject === "string" && IDENTITY_SUBJECT.test(b.subject) &&
    typeof b.key === "string" && KEY.test(b.key) && typeof b.nonce === "string" && BINDING_NONCE.test(b.nonce) &&
    isInt(b.issuedAt) && isInt(b.expiresAt) && b.expiresAt > b.issuedAt && b.expiresAt - b.issuedAt <= IDENTITY_MAX_VALIDITY &&
    // ISO dates in the text need years 1970–9999.
    b.expiresAt < 253_402_300_800;
}

/**
 * The canonical statement, one line, so it survives every tool and clipboard (no line-ending
 * ambiguity). Every field is space-free and the order is fixed, so the text is injective.
 */
export function identityStatementText(b: IdentityBinding): string {
  if (!isIdentityBinding(b)) throw new Error("Invalid identity binding");
  return `${IDENTITY_STATEMENT_PREFIX}: I control ${b.provider}:${b.subject} and authorize the Ghostly key ${b.key} ` +
    `to present it to contacts I choose, from ${iso(b.issuedAt)} until ${iso(b.expiresAt)}. Nonce: ${b.nonce}`;
}

export function identityStatement(binding: IdentityBinding): IdentityStatement {
  const text = identityStatementText(binding);
  const bytes = utf8Encode(text);
  return { binding: { ...binding }, text, bytes, id: hex(sha256(bytes)) };
}

/** A new binding and the seed of its proof key. The seed stays in this profile; never share it. */
export function newIdentityBinding(options: { provider: string; subject: string; validitySeconds: number; now?: number }): { binding: IdentityBinding; seed: Uint8Array } {
  const issuedAt = options.now ?? nowSeconds();
  const seed = randomBytes(32);
  const binding: IdentityBinding = { v: 1, provider: options.provider, subject: options.subject,
    key: identityFromSeed(seed).pubKeyZ32, issuedAt, expiresAt: issuedAt + options.validitySeconds, nonce: toBase64Url(randomBytes(16)) };
  if (!isIdentityBinding(binding)) { seed.fill(0); throw new Error("Invalid identity provider, subject or validity"); }
  return { binding, seed };
}

/** Bytes the proof key signs for one contact. `scope` is the presenter's view (subject = presenter). */
export function identityPresentationBytes(proofId: string, scope: IdentityScope, nonce: string, issuedAt: number): Uint8Array {
  return utf8Encode(JSON.stringify(["ghostly-identity-presentation", 1, proofId, scope.subject, scope.audience, scope.context, scope.session, nonce, issuedAt]));
}

export function signIdentityPresentation(seed: Uint8Array, proofId: string, scope: IdentityScope, nonce: string, issuedAt: number): string {
  return toBase64Url(sign(identityPresentationBytes(proofId, scope, nonce, issuedAt), seed));
}

export function verifyIdentityPresentation(key: string, sig: string, proofId: string, scope: IdentityScope, nonce: string, issuedAt: number): boolean {
  if (typeof sig !== "string" || !SIG.test(sig) || !KEY.test(key)) return false;
  return verify(fromBase64Url(sig), identityPresentationBytes(proofId, scope, nonce, issuedAt), publicKeyFromZ32(key));
}

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- Strip control and bidi-override characters from peer-supplied text.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  return text ? text.slice(0, max) : undefined;
};

/** Bounds a provider's result so a buggy provider cannot store or show arbitrary data. */
export function boundVerifiedIdentity(v: VerifiedIdentity): VerifiedIdentity {
  if (!v || typeof v.subject !== "string" || !IDENTITY_SUBJECT.test(v.subject)) throw new Error("Provider returned an invalid subject");
  const source = clean(v.source, 120);
  if (!source) throw new Error("Provider did not say how it verified");
  const out: VerifiedIdentity = { subject: v.subject, source };
  const attester = clean(v.attester, 253);
  if (attester) out.attester = attester;
  if (v.expiresAt !== undefined) { if (!isInt(v.expiresAt)) throw new Error("Provider returned an invalid expiry"); out.expiresAt = v.expiresAt; }
  if (v.display) {
    const d = v.display;
    const display: IdentityDisplay = { source: clean(d.source, 120) ?? "Self-described", fetchedAt: isInt(d.fetchedAt) ? d.fetchedAt : nowSeconds() };
    const name = clean(d.name, 64);
    if (name) display.name = name;
    if (typeof d.avatar === "string" && d.avatar.length <= 48 * 1024 && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(d.avatar)) display.avatar = d.avatar;
    if (typeof d.url === "string" && d.url.length <= 512) { try { const u = new URL(d.url); if (u.protocol === "https:" && !u.username && !u.password) display.url = u.href; } catch { /* dropped */ } }
    out.display = display;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-conversation exchange

/** Sharer side, one per proof shared in this conversation. */
export interface SharedIdentity {
  id: string;
  provider: string;
  subject: string;
  /** queued: the person chose to share, the contact is not connected yet. */
  status: "queued" | "pending" | "accepted" | "rejected" | "withdrawal-pending" | "withdrawn";
  /** Seconds. When the status last changed. */
  at: number;
  error?: string;
}

/** Verifier side: a contact's proof as this app checked it. */
export interface ReceivedIdentity {
  id: string;
  binding: IdentityBinding;
  evidence: unknown;
  verified: VerifiedIdentity;
  /** The participation keys it was presented between (presenter, then this side). */
  presenter: string;
  audience: string;
  context: string;
  verifiedAt: number;
  checkedAt: number;
  /**
   * unconfirmed: a re-check failed (the domain record is gone, the account cannot be confirmed).
   * revoked: its proof key published a revocation (the person removed it from their profile).
   */
  status: "verified" | "withdrawn" | "unconfirmed" | "revoked";
  error?: string;
  /** A name/picture looked up on the person's request (Nostr kind-0), with its source. */
  display?: IdentityDisplay;
}

export interface IdentityChallenge { nonce: string; issuedAt: number; provider: string }

export interface IdentityLedger {
  challenges: IdentityChallenge[];
  shared: SharedIdentity[];
  received: ReceivedIdentity[];
}
export const emptyIdentityLedger = (): IdentityLedger => ({ challenges: [], shared: [], received: [] });

export interface LocalIdentityProof { statement: IdentityStatement; evidence: unknown; seed: Uint8Array }

export interface IdentityExchangeOptions {
  /** This side's view of the authenticated channel; throws when there is none. */
  scope(): IdentityScope;
  send(frame: object): void;
  storage: { read(): IdentityLedger; update(change: (ledger: IdentityLedger) => IdentityLedger): Promise<void> };
  /** Providers this app can verify. */
  providers(): readonly string[];
  /** A proof of this profile, by id; undefined once removed. */
  localProof(id: string): LocalIdentityProof | undefined | Promise<LocalIdentityProof | undefined>;
  /** Parses and checks untrusted evidence for a statement (the registry's `verifyIdentity`). */
  verify(statement: IdentityStatement, evidence: unknown): Promise<VerifiedIdentity>;
  /** Looks up the proof key's revocation record. Resolves false when there is none or it cannot be read. */
  revoked?(statement: IdentityStatement): Promise<boolean>;
  now?(): number;
  onError?(error: string): void;
}

export type IdentityStatus = "verified" | "expired" | "withdrawn" | "revoked" | "unconfirmed" | "previous-key";

/** What the verifier should show for a received proof right now. */
export function receivedIdentityStatus(r: ReceivedIdentity, presenter: string | undefined, audience: string | undefined, now = nowSeconds()): IdentityStatus {
  if (r.presenter !== presenter || r.audience !== audience) return "previous-key";
  if (r.status === "withdrawn") return "withdrawn";
  if (r.status === "revoked") return "revoked";
  if (Math.min(r.binding.expiresAt, r.verified.expiresAt ?? Infinity) <= now) return "expired";
  return r.status === "unconfirmed" ? "unconfirmed" : "verified";
}

const shortError = (e: unknown) => clean(e instanceof Error ? e.message : String(e), 160) ?? "Invalid proof";

/**
 * A check this side could not finish because of what its own network did: a host it refused to contact, a server
 * that did not answer or answered an error. The message is for this side only. The contact is told the proof could
 * not be checked, never which host, address or status was seen, so a proof cannot make a contact's app report on
 * the network it sits in.
 */
export class IdentityCheckUnavailable extends Error {
  constructor(message: string) { super(message); this.name = "IdentityCheckUnavailable"; }
}

/** What the contact is told when the check failed with an IdentityCheckUnavailable. */
export const IDENTITY_CHECK_UNAVAILABLE = "Your contact's app could not check it. Try again later.";

const peerError = (e: unknown) => e instanceof IdentityCheckUnavailable ? IDENTITY_CHECK_UNAVAILABLE : shortError(e);

/**
 * The `idp-*` exchange of one conversation. Frames (all JSON, additive, over the paired channel,
 * only when both offers carry `identity-proof/1`):
 *
 *   idp-hello     {providers}                      each side, when the channel is ready
 *   idp-request   {id, provider}                   sharer → verifier: "give me a challenge for this proof"
 *   idp-challenge {id, nonce, issuedAt}            verifier, after saving the nonce
 *   idp-present   {nonce, issuedAt, binding, evidence, sig}
 *   idp-result    {id, ok, error?}                 verifier, after saving the outcome
 *   idp-withdraw  {id} / idp-withdrawn {id}
 */
export class IdentityExchange {
  private peerProviders: readonly string[] | undefined;
  private requested = new Set<string>();
  constructor(private options: IdentityExchangeOptions) {}
  private now() { return (this.options.now ?? nowSeconds)(); }
  private incomingScope(): IdentityScope { const s = this.options.scope(); return { ...s, subject: s.audience, audience: s.subject }; }
  private send(frame: object) {
    if (JSON.stringify(frame).length > IDENTITY_MAX_FRAME) throw new Error("Identity proof too large");
    this.options.send(frame);
  }
  private shared(id: string) { return this.options.storage.read().shared.find(s => s.id === id); }
  private async setShared(entry: SharedIdentity) {
    await this.options.storage.update(l => ({ ...l, shared: [...l.shared.filter(s => s.id !== entry.id), entry] }));
  }

  /** The providers the contact said it verifies; undefined until its hello. */
  get contactProviders(): readonly string[] | undefined { return this.peerProviders; }

  /** The channel is ready: say what we verify, then send what the person queued while offline. */
  ready(): void {
    this.options.scope();
    this.send({ t: "idp-hello", providers: [...this.options.providers()] });
    for (const s of this.options.storage.read().shared) {
      if (s.status === "queued" || s.status === "pending") this.request(s);
      else if (s.status === "withdrawal-pending") this.send({ t: "idp-withdraw", id: s.id });
    }
  }
  stop(): void { this.requested.clear(); this.peerProviders = undefined; }

  /** Share a proof of this profile with this contact: now if connected, else when it next is. */
  async share(id: string, connected: boolean): Promise<void> {
    const local = await this.options.localProof(id);
    if (!local) throw new Error("That identity is no longer in your profile");
    const { provider, subject } = local.statement.binding;
    const entry: SharedIdentity = { id, provider, subject, status: "queued", at: this.now() };
    await this.setShared(entry);
    if (connected) this.request(entry);
  }
  private request(s: SharedIdentity) {
    this.requested.add(s.id);
    this.send({ t: "idp-request", id: s.id, provider: s.provider });
  }

  /** Stop sharing here. The contact is told (now or on reconnect); a copy it kept cannot be erased. */
  async withdraw(id: string, connected: boolean): Promise<void> {
    const s = this.shared(id);
    if (!s || s.status === "withdrawn") return;
    this.requested.delete(id);
    if (s.status === "queued") { await this.options.storage.update(l => ({ ...l, shared: l.shared.filter(x => x.id !== id) })); return; }
    await this.setShared({ ...s, status: "withdrawal-pending", at: this.now(), error: undefined });
    if (connected) this.send({ t: "idp-withdraw", id });
  }

  /**
   * Run the checks again on a received proof: its revocation record, then (unless `revocationOnly`) the
   * provider's check (a domain record may be gone).
   */
  async recheck(id: string, { revocationOnly = false } = {}): Promise<ReceivedIdentity> {
    const r = this.options.storage.read().received.find(x => x.id === id);
    if (!r) throw new Error("Unknown identity");
    if (r.status === "revoked") return r;
    let next: ReceivedIdentity;
    const settled = r.status === "withdrawn";
    if (await this.options.revoked?.(identityStatement(r.binding)).catch(() => false)) {
      next = { ...r, status: "revoked", checkedAt: this.now(), error: undefined };
      await this.options.storage.update(l => ({ ...l, received: l.received.map(x => x.id === id ? next : x) }));
      return next;
    }
    if (revocationOnly) return r;
    try {
      const verified = boundVerifiedIdentity(await this.options.verify(identityStatement(r.binding), r.evidence));
      if (verified.subject !== r.verified.subject) throw new Error("The identity changed");
      next = { ...r, verified: { ...verified, display: verified.display ?? r.verified.display }, checkedAt: this.now(), status: settled ? "withdrawn" : "verified", error: undefined };
    } catch (e) {
      next = { ...r, checkedAt: this.now(), status: settled ? "withdrawn" : "unconfirmed", error: shortError(e) };
    }
    await this.options.storage.update(l => ({ ...l, received: l.received.map(x => x.id === id ? next : x) }));
    return next;
  }

  async receive(frame: Record<string, unknown>): Promise<void> {
    try {
      if (JSON.stringify(frame).length > IDENTITY_MAX_FRAME) throw new Error("Identity proof too large");
      const id = typeof frame.id === "string" && HEX64.test(frame.id) ? frame.id : undefined;
      switch (frame.t) {
        case "idp-hello":
          if (Array.isArray(frame.providers) && frame.providers.length <= 64)
            this.peerProviders = frame.providers.filter((p): p is string => typeof p === "string" && IDENTITY_PROVIDER_ID.test(p));
          return;
        case "idp-request": return await this.onRequest(id, frame.provider);
        case "idp-challenge": return await this.onChallenge(id, frame.nonce, frame.issuedAt);
        case "idp-present": return await this.onPresent(frame);
        case "idp-result": {
          const s = id ? this.shared(id) : undefined;
          if (!s || s.status !== "pending") return;
          await this.setShared({ ...s, status: frame.ok === true ? "accepted" : "rejected", at: this.now(), error: frame.ok === true ? undefined : clean(frame.error, 160) ?? "Your contact could not verify it" });
          return;
        }
        case "idp-withdraw":
          if (!id) return;
          await this.options.storage.update(l => ({ ...l, received: l.received.map(r => r.id === id ? { ...r, status: "withdrawn" } : r) }));
          this.send({ t: "idp-withdrawn", id });
          return;
        case "idp-withdrawn": {
          const s = id ? this.shared(id) : undefined;
          if (s?.status === "withdrawal-pending") await this.setShared({ ...s, status: "withdrawn", at: this.now() });
          return;
        }
      }
    } catch (e) { this.options.onError?.(shortError(e)); }
  }

  private async onRequest(id: string | undefined, provider: unknown) {
    if (!id) return;
    if (typeof provider !== "string" || !this.options.providers().includes(provider)) {
      this.send({ t: "idp-result", id, ok: false, error: "Your contact's app cannot verify this kind of identity yet" });
      return;
    }
    this.options.scope();
    const now = this.now();
    const challenge: IdentityChallenge = { nonce: toBase64Url(randomBytes(32)), issuedAt: now, provider };
    // Saved before it is sent: a presentation for a nonce this side never saved is always refused.
    await this.options.storage.update(l => {
      const live = l.challenges.filter(c => c.issuedAt > now - IDENTITY_CHALLENGE_WINDOW);
      if (live.length >= MAX_CHALLENGES) throw new Error("Too many identity challenges");
      return { ...l, challenges: [...live, challenge] };
    });
    this.send({ t: "idp-challenge", id, nonce: challenge.nonce, issuedAt: challenge.issuedAt });
  }

  private async onChallenge(id: string | undefined, nonce: unknown, issuedAt: unknown) {
    if (!id || !this.requested.has(id) || typeof nonce !== "string" || !CHALLENGE_NONCE.test(nonce) || !isInt(issuedAt)) return;
    const s = this.shared(id);
    if (!s || (s.status !== "queued" && s.status !== "pending")) return;
    this.requested.delete(id);
    const local = await this.options.localProof(id);
    if (!local) { await this.setShared({ ...s, status: "rejected", at: this.now(), error: "That identity is no longer in your profile" }); return; }
    const scope = this.options.scope();
    const sig = signIdentityPresentation(local.seed, id, scope, nonce, issuedAt);
    await this.setShared({ ...s, status: "pending", at: this.now(), error: undefined });
    this.send({ t: "idp-present", nonce, issuedAt, binding: local.statement.binding, evidence: local.evidence, sig });
  }

  private async onPresent(frame: Record<string, unknown>) {
    const { nonce, issuedAt, binding, evidence, sig } = frame;
    if (typeof nonce !== "string" || !CHALLENGE_NONCE.test(nonce) || !isInt(issuedAt) || !isIdentityBinding(binding)) return;
    const statement = identityStatement(binding);
    const id = statement.id;
    const scope = this.incomingScope();
    const now = this.now();
    const known = (l: IdentityLedger) => l.challenges.some(c => c.nonce === nonce && c.issuedAt === issuedAt && c.provider === binding.provider && c.issuedAt > now - IDENTITY_CHALLENGE_WINDOW);
    if (!known(this.options.storage.read())) throw new Error("Unknown or reused identity challenge");
    let verified: VerifiedIdentity | undefined;
    // Only what the contact may know: see IdentityCheckUnavailable.
    let error: string | undefined;
    try {
      if (JSON.stringify(evidence ?? null).length > IDENTITY_MAX_EVIDENCE) throw new Error("Evidence too large");
      if (!verifyIdentityPresentation(binding.key, sig as string, id, scope, nonce, issuedAt)) throw new Error("The proof key did not sign this conversation's challenge");
      if (binding.issuedAt > now + IDENTITY_CLOCK_SKEW) throw new Error("The proof is dated in the future");
      const result = boundVerifiedIdentity(await this.options.verify(statement, evidence));
      if (Math.min(binding.expiresAt, result.expiresAt ?? Infinity) <= now) throw new Error("The proof has expired");
      // A presentation needs the proof key, so this only matters when its seed leaked: a lookup that
      // fails is not a refusal, a revocation found is.
      if (await this.options.revoked?.(statement).catch(() => false)) throw new Error("Its owner revoked this proof");
      verified = result;
    } catch (e) { error = peerError(e); }
    // Consuming the nonce and recording the outcome are one transaction.
    await this.options.storage.update(l => {
      if (!known(l)) throw new Error("Unknown or reused identity challenge");
      const challenges = l.challenges.filter(c => c.nonce !== nonce);
      if (!verified) return { ...l, challenges };
      const record: ReceivedIdentity = { id, binding, evidence, verified, presenter: scope.subject, audience: scope.audience, context: scope.context,
        verifiedAt: now, checkedAt: now, status: "verified" };
      // A newer proof of the same identity replaces the older one.
      const received = l.received.filter(r => r.id !== id && !(r.binding.provider === binding.provider && r.verified.subject === verified!.subject));
      return { ...l, challenges, received: [...received, record] };
    });
    this.send(verified ? { t: "idp-result", id, ok: true } : { t: "idp-result", id, ok: false, error });
  }
}
