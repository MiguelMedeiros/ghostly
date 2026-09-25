import {
  emptyIdentityLedger, fromBase64Url, identityRevocationValue, identityStatement, IdentityExchange, IDENTITY_REVOCATION_LABEL, newIdentityBinding,
  receivedIdentityStatus, revokesIdentity, toBase64Url,
  type IdentityBinding, type IdentityLedger, type IdentityScope, type IdentityStatement, type LocalIdentityProof, type VerifiedIdentity,
} from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./paymentAdapters/persistence";
import type { IdentityProofProvider } from "../proofs/contract";
import { identityProviders } from "../proofs/registry";
import { boundedIdentityFetch, verifyIdentity } from "../proofs/verify";
import type { IdentityProofView, LinkIdentitiesView } from "../shared/types";

/** A proof key's seed, sealed with a device key like the wallet seeds. It never leaves the profile. */
export interface SealedProofKey { sealed: EncryptedSeed; deviceKey: string }

/** A proof of this profile, as stored. */
export interface StoredIdentityProof {
  binding: IdentityBinding;
  evidence: unknown;
  seed: SealedProofKey;
  verified: VerifiedIdentity;
  createdAt: number;
}

/** A removed proof whose revocation is republished, under its proof key, until the proof would have expired. */
interface Revocation { id: string; key: string; seed: SealedProofKey; revokedAt: number; expiresAt: number }

/** What the engine gives the identity module about a chat. */
export interface IdentityLinkHost {
  /** Paired chats only; undefined for others. */
  ledger(linkId: string): IdentityLedger | undefined;
  updateLedger(linkId: string, change: (ledger: IdentityLedger) => IdentityLedger): Promise<IdentityLedger>;
  /** The authenticated channel, when both sides offer identity proofs and it is open. */
  channel(linkId: string): { scope(): IdentityScope; send(frame: object): void } | undefined;
  /** Both participation keys of the chat, for the status of what the contact shared. */
  keys(linkId: string): { mine?: string; theirs?: string };
  linkIds(): string[];
  online(): boolean;
  emit(): void;
  /** Pkarr (the Ghost DHT or its relays): publish records under a key, read a key's latest records. */
  publish(seed: Uint8Array, records: { label: string; value: string }[]): Promise<void>;
  resolve(key: string): Promise<{ label: string; value: string }[] | null>;
}

const KEY = "identityProofs";
const REVOCATIONS = "identityRevocations";
/** Relays and the DHT forget a record within hours: republish revocations this often while the app runs. */
const REPUBLISH_MS = 60 * 60_000;
/** How often the contacts' proofs are looked up for a revocation (and once shortly after start). */
const REVOCATION_CHECK_MS = 12 * 60 * 60_000;
const DRAFT_TTL = 30 * 60_000;
const MAX_DRAFTS = 4;
const MAX_PROOFS = 32;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Identity proofs, engine side: the profile's own proofs (made once, on the Identities page) and, per
 * chat, the `IdentityExchange` that shares them with that contact and checks what the contact shares.
 * Providers come from the registry; their `verify` runs here, through the shared checks.
 */
export class IdentityProofs {
  private proofs: StoredIdentityProof[] = [];
  private revocations: Revocation[] = [];
  /** Unsealed proof-key seeds, by proof id, for this run only. */
  private seeds = new Map<string, Uint8Array>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private drafts = new Map<string, { binding: IdentityBinding; seed: Uint8Array; at: number }>();
  private exchanges = new Map<string, IdentityExchange>();
  private errors = new Map<string, string>();
  /** Chats whose current connection already got the hello: "ready" is reported more than once per connection. */
  private greeted = new Set<string>();
  private readonly fetch: ReturnType<typeof boundedIdentityFetch>;

  constructor(private host: IdentityLinkHost, private providers: () => readonly IdentityProofProvider[] = identityProviders) {
    this.fetch = boundedIdentityFetch({ online: host.online });
  }

  async load(): Promise<void> {
    const settings = await store(STORES.settings, "readonly");
    [this.proofs, this.revocations] = await Promise.all([
      wrap<StoredIdentityProof[] | undefined>(settings.get(KEY)).then(v => v ?? []),
      wrap<Revocation[] | undefined>(settings.get(REVOCATIONS)).then(v => v ?? []),
    ]);
  }
  /** Background work: republish revocations, look up the contacts' proofs for revocations. */
  start(): void {
    const every = (ms: number, first: number, work: () => Promise<void>) => {
      const tick = () => { void work().catch(() => {}).finally(() => { this.timers.push(setTimeout(tick, ms)); }); };
      this.timers.push(setTimeout(tick, first));
    };
    every(REPUBLISH_MS, 5_000, () => this.republish());
    every(REVOCATION_CHECK_MS, 60_000, () => this.checkRevocations());
  }
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const seed of this.seeds.values()) seed.fill(0);
    this.seeds.clear();
  }
  private async save(proofs: StoredIdentityProof[], revocations = this.revocations): Promise<void> {
    await transact([STORES.settings], stores => { stores[STORES.settings].put(proofs, KEY); stores[STORES.settings].put(revocations, REVOCATIONS); });
    this.proofs = proofs;
    this.revocations = revocations;
    this.host.emit();
  }
  private async seedOf(id: string, sealed: SealedProofKey): Promise<Uint8Array> {
    let seed = this.seeds.get(id);
    if (!seed) { seed = fromBase64Url(await unsealSeed(sealed.sealed, sealed.deviceKey)); this.seeds.set(id, seed); }
    return seed;
  }

  private ctx() { return { now: now(), signal: AbortSignal.timeout(30_000), fetch: this.fetch }; }
  private verify = (statement: IdentityStatement, evidence: unknown) => verifyIdentity(this.providers(), statement, evidence, this.ctx());
  private revoked = async (statement: IdentityStatement): Promise<boolean> => {
    if (!this.host.online()) return false;
    const records = await this.host.resolve(statement.binding.key);
    return !!records && revokesIdentity(records, statement.id);
  };

  private async local(id: string): Promise<LocalIdentityProof | undefined> {
    const p = this.proofs.find(x => identityStatement(x.binding).id === id);
    return p && { statement: identityStatement(p.binding), evidence: p.evidence, seed: await this.seedOf(id, p.seed) };
  }

  // -- the profile's proofs --------------------------------------------------------------------

  /** Step 1 of adding a proof: a fresh proof key and the statement the external identity must sign. */
  begin({ provider, subject, validityDays }: { provider: string; subject: string; validityDays?: number }): { draftId: string; binding: IdentityBinding } {
    const p = this.providers().find(x => x.id === provider);
    if (!p) throw new Error("Unknown kind of identity");
    const days = validityDays ?? p.validity.defaultDays;
    if (!Number.isInteger(days) || days < 1 || days > p.validity.maxDays) throw new Error(`Choose between 1 and ${p.validity.maxDays} days`);
    const canonical = p.subject.normalize(subject);
    for (const [id, d] of this.drafts) if (Date.now() - d.at > DRAFT_TTL) { d.seed.fill(0); this.drafts.delete(id); }
    while (this.drafts.size >= MAX_DRAFTS) { const [id, d] = this.drafts.entries().next().value!; d.seed.fill(0); this.drafts.delete(id); }
    const { binding, seed } = newIdentityBinding({ provider, subject: canonical, validitySeconds: days * 86_400 });
    const draftId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    this.drafts.set(draftId, { binding, seed, at: Date.now() });
    return { draftId, binding };
  }

  /** Step 2: the evidence. Verified here, exactly as a contact will, before anything is saved. */
  async complete({ draftId, evidence }: { draftId: string; evidence: unknown }): Promise<IdentityProofView> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error("This proof was started too long ago. Start again.");
    const statement = identityStatement(draft.binding);
    const verified = await this.verify(statement, JSON.parse(JSON.stringify(evidence ?? null)));
    if (this.proofs.length >= MAX_PROOFS) throw new Error("Remove an identity first");
    this.drafts.delete(draftId);
    const deviceKey = newDeviceKey();
    const stored: StoredIdentityProof = { binding: draft.binding, evidence, seed: { sealed: await sealSeed(toBase64Url(draft.seed), deviceKey), deviceKey }, verified, createdAt: Date.now() };
    this.seeds.set(statement.id, draft.seed);
    await this.save([...this.proofs, stored]);
    return this.viewOf(stored);
  }

  cancel({ draftId }: { draftId: string }): void {
    this.drafts.get(draftId)?.seed.fill(0);
    this.drafts.delete(draftId);
  }

  /**
   * Removes a proof from the profile: withdrawn from every chat it was shared in (each contact is told now
   * or when it next connects), and revoked for good, by a record its proof key publishes on Pkarr and this
   * app republishes until the proof would have expired, for contacts it never reconnects to.
   */
  async remove({ id }: { id: string }): Promise<void> {
    const proof = this.proofs.find(p => identityStatement(p.binding).id === id);
    if (!proof) return;
    for (const linkId of this.host.linkIds()) {
      const shared = this.host.ledger(linkId)?.shared.find(s => s.id === id);
      if (shared && shared.status !== "withdrawn") await this.exchange(linkId)?.withdraw(id, !!this.host.channel(linkId));
    }
    const revocation: Revocation = { id, key: proof.binding.key, seed: proof.seed, revokedAt: now(), expiresAt: Math.min(proof.binding.expiresAt, proof.verified.expiresAt ?? Infinity) };
    const wasShared = this.host.linkIds().some(l => this.host.ledger(l)?.shared.some(s => s.id === id));
    await this.save(this.proofs.filter(p => p !== proof), wasShared && revocation.expiresAt > now() ? [...this.revocations, revocation] : this.revocations);
    if (wasShared) void this.publishRevocation(revocation).catch(() => {});
    else { this.seeds.get(id)?.fill(0); this.seeds.delete(id); }
  }

  private async publishRevocation(r: Revocation): Promise<void> {
    if (!this.host.online()) return;
    await this.host.publish(await this.seedOf(r.id, r.seed), [{ label: IDENTITY_REVOCATION_LABEL, value: identityRevocationValue(r.id, r.revokedAt) }]);
  }
  private async republish(): Promise<void> {
    const live = this.revocations.filter(r => r.expiresAt > now());
    if (live.length !== this.revocations.length) {
      for (const r of this.revocations) if (!live.includes(r)) { this.seeds.get(r.id)?.fill(0); this.seeds.delete(r.id); }
      await this.save(this.proofs, live);
    }
    for (const r of live) await this.publishRevocation(r).catch(() => {});
  }
  /** Looks up every contact's current proofs for a revocation (the Pkarr record only, not the provider). */
  async checkRevocations(): Promise<void> {
    if (!this.host.online()) return;
    for (const linkId of this.host.linkIds()) {
      for (const r of this.host.ledger(linkId)?.received ?? []) {
        if (r.status === "verified" || r.status === "unconfirmed") await this.exchange(linkId)?.recheck(r.id, { revocationOnly: true }).catch(() => {});
      }
    }
  }

  views(): IdentityProofView[] {
    return this.proofs.map(p => this.viewOf(p));
  }
  private viewOf(p: StoredIdentityProof): IdentityProofView {
    const id = identityStatement(p.binding).id;
    const sharedWith = this.host.linkIds().filter(l => this.host.ledger(l)?.shared.some(s => s.id === id && s.status !== "withdrawn" && s.status !== "withdrawal-pending" && s.status !== "rejected")).length;
    const publicUri = this.publicUri(p);
    return { id, provider: p.binding.provider, subject: p.binding.subject, key: p.binding.key, verified: p.verified,
      issuedAt: p.binding.issuedAt, expiresAt: Math.min(p.binding.expiresAt, p.verified.expiresAt ?? Infinity), createdAt: p.createdAt, sharedWith,
      ...(publicUri ? { publicUri } : {}) };
  }

  /** What the profile's public DID would list for this identity: the provider's URI for the verified subject, if well formed. */
  private publicUri(p: StoredIdentityProof): string | undefined {
    try {
      const uri = this.providers().find(x => x.id === p.binding.provider)?.publicUri?.(p.verified.subject);
      return uri && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s,;]+$/.test(uri) ? uri : undefined;
    } catch {
      return undefined;
    }
  }

  // -- per chat ----------------------------------------------------------------------------------

  private exchange(linkId: string): IdentityExchange | undefined {
    if (!this.host.ledger(linkId)) return undefined;
    let x = this.exchanges.get(linkId);
    if (!x) {
      x = new IdentityExchange({
        scope: () => { const c = this.host.channel(linkId); if (!c) throw new Error("Connect to this contact first"); return c.scope(); },
        send: frame => { const c = this.host.channel(linkId); if (!c) throw new Error("Connect to this contact first"); c.send(frame); },
        storage: {
          read: () => this.host.ledger(linkId) ?? emptyIdentityLedger(),
          update: async change => { await this.host.updateLedger(linkId, change); this.host.emit(); },
        },
        providers: () => this.providers().map(p => p.id),
        localProof: id => this.local(id),
        verify: this.verify,
        revoked: this.revoked,
        onError: error => { this.errors.set(linkId, error); this.host.emit(); },
      });
      this.exchanges.set(linkId, x);
    }
    return x;
  }

  async share({ linkId, id }: { linkId: string; id: string }): Promise<void> {
    const x = this.exchange(linkId);
    if (!x) throw new Error("Identities can be shared in paired chats only");
    const p = this.proofs.find(q => identityStatement(q.binding).id === id);
    if (!p) throw new Error("That identity is no longer in your profile");
    if (Math.min(p.binding.expiresAt, p.verified.expiresAt ?? Infinity) <= now())
      throw new Error("This identity has expired. Make a new proof in your profile.");
    this.errors.delete(linkId);
    await x.share(id, !!this.host.channel(linkId));
  }
  async withdraw({ linkId, id }: { linkId: string; id: string }): Promise<void> {
    await this.exchange(linkId)?.withdraw(id, !!this.host.channel(linkId));
  }
  /** The contact's proof, checked again: its revocation record, then the provider's own check. */
  async recheck({ linkId, id }: { linkId: string; id: string }): Promise<void> {
    if (!this.host.online()) throw new Error("Offline: turn the network on to check again");
    await this.exchange(linkId)?.recheck(id);
  }
  /** Only on the person's request: the provider's public name/picture for a verified identity. */
  async lookupDisplay({ linkId, id }: { linkId: string; id: string }): Promise<void> {
    if (!this.host.online()) throw new Error("Offline: turn the network on first");
    const r = this.host.ledger(linkId)?.received.find(x => x.id === id);
    const provider = r && this.providers().find(p => p.id === r.binding.provider);
    if (!r || !provider?.lookupDisplay) throw new Error("No public profile for this identity");
    const display = await provider.lookupDisplay(r.verified.subject, { signal: AbortSignal.timeout(15_000) });
    if (!display) throw new Error("No public profile found");
    await this.host.updateLedger(linkId, l => ({ ...l, received: l.received.map(x => x.id === id && x.verified.subject === r.verified.subject ? { ...x, display } : x) }));
    this.host.emit();
  }

  frame(linkId: string, frame: Record<string, unknown>): Promise<void> {
    return this.exchange(linkId)?.receive(frame) ?? Promise.resolve();
  }
  ready(linkId: string): void {
    if (this.greeted.has(linkId) || !this.host.channel(linkId)) return;
    try { this.exchange(linkId)?.ready(); this.greeted.add(linkId); } catch { /* the channel closed again */ }
  }
  closed(linkId: string): void {
    this.greeted.delete(linkId);
    this.exchanges.get(linkId)?.stop();
  }
  forget(linkId: string): void {
    this.greeted.delete(linkId);
    this.exchanges.get(linkId)?.stop();
    this.exchanges.delete(linkId);
    this.errors.delete(linkId);
  }

  linkView(linkId: string, supported: boolean): LinkIdentitiesView | undefined {
    const ledger = this.host.ledger(linkId);
    if (!ledger) return undefined;
    const { mine, theirs } = this.host.keys(linkId);
    const t = now();
    return {
      support: supported,
      contactProviders: supported ? this.exchanges.get(linkId)?.contactProviders?.slice() : undefined,
      shared: ledger.shared,
      received: ledger.received.map(r => {
        const provider = this.providers().find(p => p.id === r.binding.provider);
        return { id: r.id, provider: r.binding.provider, subject: r.verified.subject, verified: r.verified, display: r.display,
          status: receivedIdentityStatus(r, theirs, mine, t), verifiedAt: r.verifiedAt, checkedAt: r.checkedAt,
          expiresAt: Math.min(r.binding.expiresAt, r.verified.expiresAt ?? Infinity), error: r.error,
          recheckDue: !!provider?.recheck && t - r.checkedAt >= provider.recheck.afterSeconds };
      }),
      error: this.errors.get(linkId),
    };
  }
}
