import {
  budgetRetryMs, emptyIdentityLedger, fromBase64Url, isDiscoveryBudgetError, identityRevocationValue, identityStatement, IdentityCheckUnavailable, IdentityExchange, IDENTITY_REVOCATION_LABEL, isIdentityBinding, newIdentityBinding,
  receivedIdentityStatus, revokesIdentity, toBase64Url,
  type IdentityBinding, type IdentityLedger, type IdentityScope, type ReceivedIdentity, type IdentityStatement, type LocalIdentityProof, type VerifiedIdentity,
} from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { openSecret, sealSecret, whenDataKeyDropped, type SealedSecret } from "./dataKey";
import type { IdentityFetch, IdentityProofProvider } from "../proofs/contract";
import { loadedIdentityProviders, loadIdentityProviders } from "../proofs/load";
import { boundedIdentityFetch, verifyIdentity } from "../proofs/verify";
import type { IdentityProofView, LinkIdentitiesView, PublicProfileView } from "../shared/types";

/** A proof key's seed, sealed like the wallet seeds (`dataKey.ts`). It never leaves the profile. */
export type SealedProofKey = SealedSecret;
/** Where a proof key's seed belongs: by proof id, so it still opens once the proof moved to the revocations. */
const proofKeyAt = (id: string) => ({ store: STORES.settings, key: id, field: "identityProof.seed" });

/** A proof of this profile, as stored. */
export interface StoredIdentityProof {
  binding: IdentityBinding;
  evidence: unknown;
  seed: SealedProofKey;
  verified: VerifiedIdentity;
  createdAt: number;
  /** Shared in a chat at least once: removing it then revokes it, even once that chat (and its ledger) is deleted. */
  shared?: true;
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
  /** Settings → Hide my IP from contacts: a contact's proof is then checked only on hosts this app names (`fixedIdentityHosts`). */
  relayOnly?(): boolean;
  emit(): void;
  /** The public profile kept for an identity (PUBLIC-PROFILES.md), shown only while its proof is current and verified. */
  publicProfile?(provider: string, subject: string): PublicProfileView | undefined;
  /** Pkarr (the Ghost DHT or its relays): publish records under a key, read a key's latest records. */
  publish(seed: Uint8Array, records: { label: string; value: string }[]): Promise<void>;
  resolve(key: string): Promise<{ label: string; value: string }[] | null>;
}

const KEY = "identityProofs";
const REVOCATIONS = "identityRevocations";
/** When the contacts' proofs were last looked up for a revocation (ms), so a reload does not look them all up again. */
const REVOCATIONS_CHECKED_AT = "identityRevocationsCheckedAt";
/** The lookup under way: when it began (ms) and the proofs it already looked up (`linkId|id`), so one cut short goes on from the rest. */
const REVOCATIONS_ROUND = "identityRevocationsRound";
interface LookupRound { startedAt: number; done: string[] }
/** Relays and the DHT forget a record within hours: republish revocations this often while the app runs. */
const REPUBLISH_MS = 60 * 60_000;
/** How often the contacts' proofs are looked up for a revocation (and once shortly after start). */
const REVOCATION_CHECK_MS = 12 * 60 * 60_000;
/** A lookup that could not run (offline, no relay answered) is tried again after this, doubled each time, up to the 12 h. */
const REVOCATION_RETRY_MS = 5 * 60_000;
/** A proof's lookup the relays' budget held back is read again when it frees, at most this many times; then the lookup stops there and goes on from it at its next try. */
const BUDGET_TRIES = 5;
/**
 * The 12 h lookup reads one proof key this often: 20 a minute, under half the relays' background share (44 a minute over
 * the three default relays), which the profile's DID, contact link and public profiles read through too.
 */
const REVOCATION_READ_GAP_MS = 3_000;
/**
 * After a contact withdraws a proof, how long to wait before each lookup for its revocation (WISP 300: removing a proof withdraws it from
 * every chat and revokes it). The notice goes out before the revocation is published, so not at once; each try backs
 * off, and the first that finds it stops the rest. The 12 h check covers it after that.
 */
export const WITHDRAWN_REVOCATION_TRIES_MS = [20_000, 60_000, 180_000] as const;
/**
 * A contact's proof whose provider asks for re-checks is checked again on its own (the provider's check, as "Check
 * again" runs it) this long after its last check, or the provider's own interval when longer: a domain record or a
 * listed key that is gone then stops reading verified.
 */
export const AUTO_RECHECK_AFTER_S = 86_400;
/** Due proofs are looked for this often (the first time a few minutes after the start), and only a few checked each time. */
const AUTO_RECHECK_TICK_MS = 15 * 60_000;
const AUTO_RECHECK_FIRST_MS = 3 * 60_000;
const AUTO_RECHECK_BATCH = 3;
/** A check that could not reach the server leaves the proof as it was and is tried again after this, doubling, at most a day. */
const AUTO_RECHECK_BACKOFF_MS = 2 * 60 * 60_000;
/** A proof begun and not completed is dropped this long after, or when a fifth one begins (the CLI says the same). */
export const IDENTITY_DRAFT_TTL_MS = 30 * 60_000;
export const IDENTITY_MAX_DRAFTS = 4;
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
  private revocationsCheckedAt = 0;
  /** Revocation lookups in a row that could not run: the next waits `REVOCATION_RETRY_MS` doubled this many times less one. */
  private lookupsMissed = 0;
  /** The lookup under way, if one was cut short (`REVOCATIONS_ROUND`). */
  private round: LookupRound | undefined;
  /**
   * How the last Pkarr read of each contact's proof went (`revoked`), by proof id: answered, could not run (offline, no
   * relay answered), or held back by the relays' budget, which takes reads again in this many ms.
   */
  private reads = new Map<string, "answered" | "failed" | number>();
  /** When each contact's proof was last read for a revocation this run (ms), by proof id: the 12 h lookup reads the longest unread first. */
  private lastRead = new Map<string, number>();
  private lookupTimer: ReturnType<typeof setTimeout> | undefined;
  private looking = false;
  /** Counted at each `stop`: a 12 h lookup under way ends there. */
  private stops = 0;
  /** Ends the 12 h lookup's wait (between two reads, or for the budget) at once: `stop`. */
  private wakeLookup: (() => void) | undefined;
  /** Revocations not published because the app was offline: published when the network comes back (`networkBack`). */
  private unpublished = new Set<string>();
  private running = false;
  /** "Clear all data" (`revokeAll`): a revocation lookup or a proof's save still on its way writes nothing. */
  private ended = false;
  /** Unsealed proof-key seeds, by proof id, for this run only. */
  private seeds = new Map<string, Uint8Array>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private unlisten: (() => void) | undefined;
  private drafts = new Map<string, { binding: IdentityBinding; seed: Uint8Array; at: number }>();
  private exchanges = new Map<string, IdentityExchange>();
  private saving: Promise<void> = Promise.resolve();
  private errors = new Map<string, string>();
  /** Chats whose current connection already got the hello: "ready" is reported more than once per connection. */
  private greeted = new Set<string>();
  /** Automatic re-checks that could not reach the server, by chat and proof: how many in a row, and when to try again (ms). */
  private recheckBackoff = new Map<string, { failures: number; until: number }>();
  private readonly fetch: ReturnType<typeof boundedIdentityFetch>;

  constructor(private host: IdentityLinkHost, private providers: () => readonly IdentityProofProvider[] = loadedIdentityProviders) {
    this.fetch = boundedIdentityFetch({ online: host.online });
  }

  /** The profile's proofs, and the providers that check and show them: loaded here, not with the app. */
  async load(): Promise<void> {
    const providers = loadIdentityProviders();
    const settings = await store(STORES.settings, "readonly");
    [this.proofs, this.revocations, this.revocationsCheckedAt, this.round] = await Promise.all([
      wrap<StoredIdentityProof[] | undefined>(settings.get(KEY)).then(v => v ?? []),
      wrap<Revocation[] | undefined>(settings.get(REVOCATIONS)).then(v => v ?? []),
      wrap<number | undefined>(settings.get(REVOCATIONS_CHECKED_AT)).then(v => typeof v === "number" ? v : 0),
      wrap<LookupRound | undefined>(settings.get(REVOCATIONS_ROUND)).then(v => typeof v?.startedAt === "number" && Array.isArray(v.done) ? v : undefined),
    ]);
    await providers;
  }
  /** Background work: republish revocations, look up the contacts' proofs for revocations. */
  start(): void {
    this.running = true;
    const every = (ms: number, first: number, work: () => Promise<void>) => {
      const tick = () => { void work().catch(() => {}).finally(() => { this.timers.push(setTimeout(tick, ms)); }); };
      this.timers.push(setTimeout(tick, first));
    };
    every(REPUBLISH_MS, 5_000, () => this.republish());
    // 60 s after the start, unless the last lookup (from an earlier run) was less than 12 h ago: then when those are up.
    // A clock set back since then waits 12 h at most.
    const due = Math.min(REVOCATION_CHECK_MS, this.revocationsCheckedAt + REVOCATION_CHECK_MS - Date.now());
    this.lookUpIn(Math.max(60_000, due));
    every(AUTO_RECHECK_TICK_MS, AUTO_RECHECK_FIRST_MS, () => this.recheckDue());
    this.unlisten ??= whenDataKeyDropped(() => this.forgetSeeds());
  }
  /** The network is back: a revocation lookup that could not run, and a revocation not published offline, go now. */
  networkBack(): void {
    if (!this.running || this.ended) return;
    if (this.lookupsMissed > 0) this.lookUpIn(0);
    for (const r of this.revocations) if (this.unpublished.has(r.id) && r.expiresAt > now()) void this.publishRevocation(r).catch(() => {});
  }
  private lookUpIn(ms: number): void {
    if (this.lookupTimer) clearTimeout(this.lookupTimer);
    const timer = this.lookupTimer = setTimeout(() => {
      this.timers = this.timers.filter(t => t !== timer);
      this.lookupTimer = undefined;
      void this.lookUp();
    }, ms);
    this.timers.push(timer);
  }
  /** A lookup done waits 12 h for the next; one that could not run is tried again sooner, backing off. */
  private async lookUp(): Promise<void> {
    // One still on its way plans the next itself.
    if (this.looking) return;
    this.looking = true;
    const done = await this.checkRevocations().catch(() => false);
    this.looking = false;
    if (!this.running) return;
    this.lookupsMissed = done ? 0 : this.lookupsMissed + 1;
    this.lookUpIn(done ? REVOCATION_CHECK_MS : Math.min(REVOCATION_CHECK_MS, REVOCATION_RETRY_MS * 2 ** (this.lookupsMissed - 1)));
  }
  stop(): void {
    this.running = false;
    this.stops++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.lookupTimer = undefined;
    this.wakeLookup?.();
    this.unlisten?.();
    this.unlisten = undefined;
    this.forgetSeeds();
  }
  private forgetSeeds(): void {
    for (const seed of this.seeds.values()) seed.fill(0);
    this.seeds.clear();
  }
  /**
   * Every change of the proofs and revocations, one after the other, each made on what the one before stored: two at
   * once (two proofs completed, a proof removed while another completes) both from the same list lost one of them.
   */
  private save(change: (proofs: StoredIdentityProof[], revocations: Revocation[]) => [StoredIdentityProof[], Revocation[]]): Promise<void> {
    const run = this.saving.then(async () => {
      // "Clear all data" came while a check or a removal was on its way: the list in memory is the cleared profile's.
      if (this.ended) throw new Error("This profile's data was cleared");
      const [proofs, revocations] = change(this.proofs, this.revocations);
      await transact([STORES.settings], stores => { stores[STORES.settings].put(proofs, KEY); stores[STORES.settings].put(revocations, REVOCATIONS); });
      this.proofs = proofs;
      this.revocations = revocations;
      this.host.emit();
    });
    this.saving = run.catch(() => {});
    return run;
  }
  private async seedOf(id: string, sealed: SealedProofKey): Promise<Uint8Array> {
    let seed = this.seeds.get(id);
    if (!seed) { seed = fromBase64Url(await openSecret(sealed, proofKeyAt(id))); this.seeds.set(id, seed); }
    return seed;
  }

  private ctx(fetch: IdentityFetch = this.fetch) { return { now: now(), signal: AbortSignal.timeout(30_000), fetch }; }
  /** The person's own proof, before it is saved: on whatever servers it names, their own. */
  private verify = (statement: IdentityStatement, evidence: unknown) => verifyIdentity(this.providers(), statement, evidence, this.ctx());
  /**
   * A contact's proof. With Hide my IP on, a host its evidence names (a did:web or domain's web server, an AT Protocol
   * server, a Pubky homeserver) is not contacted, since it would learn this device's IP address: the check fails as one
   * that could not run, and the contact is told only that.
   */
  private verifyContact = async (statement: IdentityStatement, evidence: unknown) => {
    if (!this.host.relayOnly?.()) return this.verify(statement, evidence);
    const { fixedIdentityHosts } = await import("../proofs/fixedHosts");
    const fixed = fixedIdentityHosts();
    let refused: string | undefined;
    const fetch: IdentityFetch = async (url, options) => {
      const host = new URL(url).host;
      if (!fixed.has(host)) { refused ??= host; throw new IdentityCheckUnavailable(`${host} was not contacted`); }
      return this.fetch(url, options);
    };
    try {
      return await verifyIdentity(this.providers(), statement, evidence, this.ctx(fetch));
    } catch (e) {
      // A provider words a failed fetch its own way ("could not be reached"): this says why it was not tried.
      if (refused) throw new IdentityCheckUnavailable(`Hide my IP from contacts is on: ${refused}, a server your contact chose, was not contacted`);
      throw e;
    }
  };
  /**
   * The exchange reads a lookup that failed as "not revoked": noted here (`reads`), so the 12 h lookup looks that proof
   * up again. One the relays' budget held back is kept apart: the lookup waits for the budget and reads it again.
   */
  private revoked = async (statement: IdentityStatement): Promise<boolean> => {
    if (!this.host.online()) { this.reads.set(statement.id, "failed"); return false; }
    const records = await this.host.resolve(statement.binding.key).catch((e: unknown) => {
      this.reads.set(statement.id, isDiscoveryBudgetError(e) ? budgetRetryMs(e, 1_000, 60_000) : "failed");
      throw e;
    });
    this.reads.set(statement.id, "answered");
    this.lastRead.set(statement.id, Date.now());
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
    for (const [id, d] of this.drafts) if (Date.now() - d.at > IDENTITY_DRAFT_TTL_MS) { d.seed.fill(0); this.drafts.delete(id); }
    while (this.drafts.size >= IDENTITY_MAX_DRAFTS) { const [id, d] = this.drafts.entries().next().value!; d.seed.fill(0); this.drafts.delete(id); }
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
    // Cancelled (or dropped) while it was checked: nothing to save, and its seed is zeroed.
    if (this.drafts.get(draftId) !== draft) throw new Error("This proof was started too long ago. Start again.");
    if (this.proofs.length >= MAX_PROOFS) throw new Error("Remove an identity first");
    this.drafts.delete(draftId);
    const stored: StoredIdentityProof = { binding: draft.binding, evidence, seed: await sealSecret(toBase64Url(draft.seed), proofKeyAt(statement.id)), verified, createdAt: Date.now() };
    this.seeds.set(statement.id, draft.seed);
    await this.save((proofs, revocations) => {
      if (proofs.length >= MAX_PROOFS) throw new Error("Remove an identity first");
      return [[...proofs, stored], revocations];
    });
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
    const wasShared = this.everShared(proof);
    const revoke = wasShared && revocation.expiresAt > now();
    await this.save((proofs, revocations) => proofs.some(p => identityStatement(p.binding).id === id)
      ? [proofs.filter(p => identityStatement(p.binding).id !== id), revoke ? [...revocations, revocation] : revocations]
      : [proofs, revocations]);
    if (wasShared) void this.publishRevocation(revocation).catch(() => {});
    else { this.seeds.get(id)?.fill(0); this.seeds.delete(id); }
  }

  /**
   * "Clear all data": every proof that was ever shared, and every removed one still being revoked, gets its revocation
   * record published once more, all at once. Nothing will republish them after the clear, so this is a last word for
   * contacts who check; proofs posted elsewhere (a Bluesky record, a Pubky file, a DNS record) are the person's to delete.
   */
  async revokeAll(): Promise<void> {
    this.ended = true;
    this.stop();
    const at = now();
    const last: Revocation[] = [
      ...this.revocations.filter(r => r.expiresAt > at),
      ...this.proofs.filter(p => this.everShared(p)).map(p => ({
        id: identityStatement(p.binding).id, key: p.binding.key, seed: p.seed, revokedAt: at, expiresAt: Math.min(p.binding.expiresAt, p.verified.expiresAt ?? Infinity),
      })),
    ];
    await Promise.allSettled(last.map(r => this.publishRevocation(r)));
    this.stop();
  }

  /** Marked when shared; the chats' ledgers still count for a proof shared before the mark was kept. */
  private everShared(p: StoredIdentityProof): boolean {
    const id = identityStatement(p.binding).id;
    return !!p.shared || this.host.linkIds().some(l => this.host.ledger(l)?.shared.some(s => s.id === id));
  }

  private async publishRevocation(r: Revocation): Promise<void> {
    if (!this.host.online()) { this.unpublished.add(r.id); return; }
    this.unpublished.delete(r.id);
    await this.host.publish(await this.seedOf(r.id, r.seed), [{ label: IDENTITY_REVOCATION_LABEL, value: identityRevocationValue(r.id, r.revokedAt) }]);
  }
  private async republish(): Promise<void> {
    const live = this.revocations.filter(r => r.expiresAt > now());
    if (live.length !== this.revocations.length) {
      for (const r of this.revocations) if (!live.includes(r)) { this.seeds.get(r.id)?.fill(0); this.seeds.delete(r.id); }
      await this.save((proofs, revocations) => [proofs, revocations.filter(r => r.expiresAt > now())]);
    }
    for (const r of live) await this.publishRevocation(r).catch(() => {});
  }
  /**
   * Looks up the contacts' proofs for a revocation (the Pkarr record only, not the provider): the ones standing, and the
   * ones withdrawn, which a removal also revokes. Not a proof already revoked, nor one past its expiry: its owner
   * publishes the revocation only until then. True when every lookup was answered: only then is its time noted.
   *
   * Each proof answered is noted in the lookup under way (`round`, kept across a restart): one cut short (a read that
   * failed, the relays' budget still held after its tries, the network gone, the app stopped) goes on later from the
   * proofs still to look up. Started again from the first, a few keys no relay answered cost every proof's read again.
   *
   * One read every `REVOCATION_READ_GAP_MS`, the longest unread first: read back to back, the lookup took the relays'
   * whole background share for a minute, and every read past it was held back.
   */
  async checkRevocations(): Promise<boolean> {
    if (!this.host.online()) return false;
    // A lookup begun 12 h ago (or after the clock was set back) is not gone on with: every proof is due again.
    const at = Date.now();
    if (!this.round || at - this.round.startedAt >= REVOCATION_CHECK_MS || this.round.startedAt > at) this.round = { startedAt: at, done: [] };
    const round = this.round, done = new Set(round.done);
    const todo = this.host.linkIds().flatMap(linkId => (this.host.ledger(linkId)?.received ?? [])
      .filter(r => this.revocable(r) && !done.has(`${linkId}|${r.id}`)).map(r => ({ linkId, id: r.id })))
      .sort((a, b) => (this.lastRead.get(a.id) ?? 0) - (this.lastRead.get(b.id) ?? 0));
    let missed = false, wait = 0;
    const stops = this.stops;
    try {
      for (const { linkId, id } of todo) {
        // The relays hold background reads past their minute's share: this one waits for it and goes again, as nobody
        // waits on the lookup. Still held after its tries, the relays are busy: the rest wait for the next try.
        for (let tries = 0; ; tries++) {
          if (wait > 0 && !await this.lookupPause(wait)) return false;
          if (this.ended || this.stops !== stops) return false;
          // The network went: the rest wait for it (`networkBack`), not each one counted a failed read.
          if (!this.host.online()) return false;
          this.reads.delete(id);
          await this.exchange(linkId)?.recheck(id, { revocationOnly: true }).catch(() => {});
          const read = this.reads.get(id);
          wait = typeof read === "number" ? read : REVOCATION_READ_GAP_MS;
          if (read === "failed") { missed = true; break; }
          if (typeof read !== "number") { round.done.push(`${linkId}|${id}`); this.saveRound(round); break; }
          if (tries >= BUDGET_TRIES) return false;
        }
      }
    } finally {
      this.reads.clear();
    }
    // "Clear all data" came meanwhile: the profile it was for is gone, and its time must not land in the cleared one.
    if (this.ended || missed) return false;
    this.revocationsCheckedAt = Date.now();
    if (this.round === round) this.round = undefined;
    await transact([STORES.settings], stores => {
      stores[STORES.settings].put(this.revocationsCheckedAt, REVOCATIONS_CHECKED_AT);
      stores[STORES.settings].delete(REVOCATIONS_ROUND);
    });
    return true;
  }
  /** Not waited on: the writes keep their order, so the lookup's end (which deletes it) lands after. */
  private saveRound(round: LookupRound): void {
    if (this.ended || this.round !== round) return;
    void transact([STORES.settings], stores => { stores[STORES.settings].put({ ...round, done: [...round.done] }, REVOCATIONS_ROUND); }).catch(() => {});
  }
  /**
   * The contacts' proofs due for an automatic re-check (`AUTO_RECHECK_AFTER_S`), the longest unchecked first, a few at a
   * time, one after the other. A proof whose record or key is gone shows unconfirmed with the reason, as after "Check
   * again"; one whose server could not be reached (or a network that went away meanwhile) is left as it was and backs off.
   */
  async recheckDue(): Promise<void> {
    if (!this.host.online()) return;
    const t = now(), at = Date.now();
    const due: { linkId: string; r: ReceivedIdentity }[] = [];
    for (const linkId of this.host.linkIds()) {
      for (const r of this.host.ledger(linkId)?.received ?? []) {
        const after = this.providers().find(p => p.id === r.binding.provider)?.recheck?.afterSeconds;
        if (after === undefined || (r.status !== "verified" && r.status !== "unconfirmed") || !this.revocable(r)) continue;
        if (t - r.checkedAt < Math.max(after, AUTO_RECHECK_AFTER_S) || (this.recheckBackoff.get(`${linkId}|${r.id}`)?.until ?? 0) > at) continue;
        due.push({ linkId, r });
      }
    }
    for (const { linkId, r } of due.sort((a, b) => a.r.checkedAt - b.r.checkedAt).slice(0, AUTO_RECHECK_BATCH)) {
      if (this.ended || !this.host.online()) return;
      const key = `${linkId}|${r.id}`;
      try {
        await this.exchange(linkId)?.recheck(r.id, { keepUnavailable: true });
        this.recheckBackoff.delete(key);
      } catch {
        const failures = (this.recheckBackoff.get(key)?.failures ?? 0) + 1;
        this.recheckBackoff.set(key, { failures, until: Date.now() + Math.min(AUTO_RECHECK_BACKOFF_MS * 2 ** (failures - 1), AUTO_RECHECK_AFTER_S * 1000) });
      }
    }
  }
  /** The 12 h lookup's wait between two reads, or for the budget: false when `stop` ended it. */
  private lookupPause(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.timers = this.timers.filter(t => t !== timer); this.wakeLookup = undefined; resolve(true); }, ms);
      this.timers.push(timer);
      this.wakeLookup = () => { clearTimeout(timer); this.wakeLookup = undefined; resolve(false); };
    });
  }
  private revocable(r: ReceivedIdentity): boolean {
    return r.status !== "revoked" && Math.min(r.binding.expiresAt, r.verified.expiresAt ?? Infinity) > now();
  }
  /** A proof the contact just withdrew: looked up for its revocation a few times (`WITHDRAWN_REVOCATION_TRIES_MS`). */
  private afterWithdrawal(linkId: string, id: string, tries: readonly number[] = WITHDRAWN_REVOCATION_TRIES_MS): void {
    const [wait, ...rest] = tries;
    if (wait === undefined) return;
    const timer = setTimeout(() => {
      this.timers = this.timers.filter(t => t !== timer);
      const r = this.host.ledger(linkId)?.received.find(x => x.id === id);
      if (!r || r.status !== "withdrawn" || !this.revocable(r)) return;
      void (async () => {
        const next = this.host.online() ? await this.exchange(linkId)?.recheck(id, { revocationOnly: true }).catch(() => undefined) : undefined;
        if (next?.status !== "revoked") this.afterWithdrawal(linkId, id, rest);
      })();
    }, wait);
    this.timers.push(timer);
  }

  /** Every engine state builds these: each chat's ledger is read once for all the proofs, not once per proof. */
  views(): IdentityProofView[] {
    const sharedWith = this.sharedWith();
    return this.proofs.map(p => this.viewOf(p, sharedWith));
  }
  /** The subjects of the profile's own proofs of one provider, without building their views (no chat's ledger is read). */
  subjects(provider: string): string[] {
    return this.proofs.filter(p => p.binding.provider === provider).map(p => p.binding.subject);
  }
  /** By proof id, the chats it is shared in (not withdrawn, nor rejected by the contact). */
  private sharedWith(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const l of this.host.linkIds()) {
      const ids = new Set<string>();
      for (const s of this.host.ledger(l)?.shared ?? []) if (s.status !== "withdrawn" && s.status !== "withdrawal-pending" && s.status !== "rejected") ids.add(s.id);
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }
  private viewOf(p: StoredIdentityProof, shared = this.sharedWith()): IdentityProofView {
    const id = identityStatement(p.binding).id;
    const sharedWith = shared.get(id) ?? 0;
    const publicUri = this.publicUri(p);
    const expiresAt = Math.min(p.binding.expiresAt, p.verified.expiresAt ?? Infinity);
    const publicProfile = expiresAt > now() ? this.host.publicProfile?.(p.binding.provider, p.verified.subject) : undefined;
    return { id, provider: p.binding.provider, subject: p.binding.subject, key: p.binding.key, verified: p.verified,
      issuedAt: p.binding.issuedAt, expiresAt, createdAt: p.createdAt, sharedWith, evidence: p.evidence,
      ...(publicUri ? { publicUri } : {}), ...(publicProfile ? { publicProfile } : {}) };
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
        verify: this.verifyContact,
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
    // Noted before it can leave the device: the chat's ledger goes if the chat is deleted, the contact's copy does not.
    if (!p.shared) await this.save((proofs, revocations) => [proofs.map(q => identityStatement(q.binding).id === id ? { ...q, shared: true as const } : q), revocations]);
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

  async frame(linkId: string, frame: Record<string, unknown>): Promise<void> {
    const x = this.exchange(linkId);
    if (!x) return;
    // A proof withdrawn now, or one whose check ends after its owner withdrew it (`idp-present`), gets its revocation lookups.
    const id = frame.t === "idp-withdraw" && typeof frame.id === "string" ? frame.id
      : frame.t === "idp-present" && isIdentityBinding(frame.binding) ? identityStatement(frame.binding).id : undefined;
    const withdrawn = () => !!id && !!this.host.ledger(linkId)?.received.some(r => r.id === id && r.status === "withdrawn");
    const before = withdrawn();
    await x.receive(frame);
    if (id && !before && withdrawn()) this.afterWithdrawal(linkId, id);
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
        const status = receivedIdentityStatus(r, theirs, mine, t);
        const publicProfile = status === "verified" ? this.host.publicProfile?.(r.binding.provider, r.verified.subject) : undefined;
        return { id: r.id, provider: r.binding.provider, subject: r.verified.subject, verified: r.verified, display: r.display,
          status, verifiedAt: r.verifiedAt, checkedAt: r.checkedAt,
          expiresAt: Math.min(r.binding.expiresAt, r.verified.expiresAt ?? Infinity), error: r.error,
          recheckDue: !!provider?.recheck && t - r.checkedAt >= provider.recheck.afterSeconds,
          ...(publicProfile ? { publicProfile } : {}) };
      }),
      error: this.errors.get(linkId),
    };
  }
}
