import {
  bytesEqual, createIdentity, didDhtDocument, didDhtFromPublicKey, encodeDidDhtDeactivated, encodeDidDhtPacket, fromBase64Url, identityFromSeed, PacketTooLargeError,
  signDidDhtPacket, toBase64Url, toZ32, type DidDhtDocument,
} from "@ghostly/core";
import { STORES, store, wrap, committed } from "../shared/idb";
import type { ProfileDidView } from "../shared/types";
import { openSecret, sealSecret, whenDataKeyDropped } from "./dataKey";
import type { SealedProofKey } from "./identities";

/**
 * The profile's did:dht (WISP 310-did-dht). Ghostly has no profile-wide key (every chat has its own), so
 * the DID has a key of its own, made once per profile, kept like a proof key and used for nothing else:
 * the DID never links chats. Its packet holds the DID document alone: the identity key and, only for
 * identities the person lists, `alsoKnownAs`. Published while online, re-put as is every hour so the
 * DHT keeps it, re-signed only when the document changes (did:dht asks for infrequent updates).
 */

interface StoredProfileDid {
  seed: SealedProofKey;
  /** base64url; the DID shows without unsealing the seed. */
  publicKey: string;
  createdAt: number;
  /** Identity proof ids listed in `alsoKnownAs`, in the order they were listed. */
  listed: string[];
  /** The last packet out there (base64url relay payload), re-put unchanged until the document changes. */
  published?: { payload: string; seq: number; at: number };
}

export interface ProfileDidHost {
  online(): boolean;
  emit(): void;
  /** The profile's identities a DID document can list now (verified, unexpired, with a URI): id → URI. */
  listable(): Map<string, string>;
  /** When a listable identity stops being listable (ms), so its expiry republishes the document. */
  expiresAt?(id: string): number | undefined;
  /** Every identity proof id of the profile, listable or not. */
  proofIds(): string[];
  /** Puts a signed packet on Pkarr as is (the relays and, on Desktop, the DHT). */
  publish(pubKeyZ32: string, payload: Uint8Array): Promise<void>;
}

const KEY = "profileDid";
const SEED_AT = { store: STORES.settings, key: KEY, field: "did.seed" };
/** Mainline keeps a mutable item about two hours: the same packet goes out again every hour. */
export const DID_REPUBLISH_MS = 60 * 60_000;
/** After start, once the chats had their first go at the relays. */
const FIRST_PUBLISH_MS = 15_000;
/** A few switches flipped in a row make one publish. */
const CHANGE_DELAY_MS = 2_000;
/** A failed publish is tried again this much later (not before the hourly one otherwise). */
const RETRY_MS = 5 * 60_000;
/** setTimeout's longest wait. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * `close` waits this long at most for the listing it publishes: what one publish took at most before it also waited for
 * the one in flight (the CLI's DHT put times out at 20 s, its relays at 10 s). A network gone dead never holds a stop.
 */
export const DID_CLOSE_WAIT_MS = 20_000;
/** Relay payload header: signature and sequence number, before the DNS packet. */
const HEADER = 72;

export class ProfileDid {
  private stored: StoredProfileDid | null = null;
  private seed: Uint8Array | null = null;
  private error: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When `timer` fires. */
  private timerAt = 0;
  private running = false;
  /** The publishes on their way: the one in flight and those asked for meanwhile (`again`). */
  private publishing: Promise<void> | null = null;
  private again = false;
  private unlisten: (() => void) | undefined;
  /** The last `samePacket` answer. */
  private compared: { payload: string; uris: string; same: boolean } | undefined;
  /** "Clear all data" ended the DID: a publish still on its way saves nothing, or the cleared record comes back. */
  private ended = false;
  /** The newest sequence number signed here, so the `deactivated` packet goes past one still on its way. */
  private signedSeq = 0;
  /** This run changed the listed identities and their document is not out yet: `close` publishes it. */
  private due = false;
  /**
   * Saves run one at a time, each on the record the one before saved: two built from the same record (two switches,
   * a switch and a publish landing, a switch and a removed proof dropped) lost the first one's change.
   */
  private saving: Promise<void> = Promise.resolve();
  /** At the first listed identity's expiry, `changed`: nothing else says it expired. */
  private expiry: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private host: ProfileDidHost) {}

  /** Reads the profile's DID, making its key the first time. */
  async load(): Promise<void> {
    const found = await wrap<StoredProfileDid | undefined>((await store(STORES.settings, "readonly")).get(KEY));
    if (found) { this.stored = found; return; }
    const identity = createIdentity();
    const made: StoredProfileDid = {
      seed: await sealSecret(identity.seedB64, SEED_AT),
      publicKey: toBase64Url(identity.publicKey),
      createdAt: Date.now(),
      listed: [],
    };
    await this.save(() => made);
    this.seed = identity.seed;
  }

  start(): void {
    this.running = true;
    this.unlisten ??= whenDataKeyDropped(() => this.forgetSeed());
    this.schedule(FIRST_PUBLISH_MS);
    this.watchExpiry();
  }

  /**
   * `stop`, once a listing this run changed is published: a CLI one-shot (`engine setDidListed`, an `identity remove` of
   * a listed proof) ended within the change's 2 s, so the DID kept the old document until a daemon ran 15 s.
   */
  async close(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.due) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.publishDue(), new Promise<void>(resolve => { timer = setTimeout(resolve, DID_CLOSE_WAIT_MS); })]);
      clearTimeout(timer);
    }
    this.stop();
  }

  /** Until the listing this run changed is out, or its publish failed. */
  private async publishDue(): Promise<void> {
    // Listing changes being saved (a removed proof dropped, a switch flipped) land before the publish reads them.
    await this.saving;
    // A publish on its way signed the document as it was then: the newer listing goes after it, in the same chain.
    await this.publishing?.catch(() => {});
    if (this.due) await this.publishNow().catch(() => {});
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.expiry) clearTimeout(this.expiry.timer);
    this.expiry = null;
    this.unlisten?.();
    this.unlisten = undefined;
    this.forgetSeed();
  }

  private forgetSeed(): void {
    this.seed?.fill(0);
    this.seed = null;
  }

  /** `did:dht:…` */
  get id(): string {
    return didDhtFromPublicKey(this.publicKey());
  }

  /** The document as it is published (or will be at the next publish). */
  document(): DidDhtDocument {
    return didDhtDocument(this.publicKey(), { alsoKnownAs: this.alsoKnownAs(this.listed()) });
  }

  /** Undefined until loaded. */
  view(): ProfileDidView | undefined {
    if (!this.stored) return undefined;
    const published = this.stored.published;
    const alsoKnownAs = this.alsoKnownAs(this.listed());
    return {
      id: this.id,
      listed: this.listed(),
      alsoKnownAs,
      ...(published ? { published: { at: published.at, versionId: String(published.seq) } } : {}),
      upToDate: !!published && this.samePacket(published.payload, alsoKnownAs),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Lists an identity in the public document, or takes it out. Only identities the profile holds and
   * a document can list; refused when the packet would not fit 1000 bytes.
   */
  async setListed({ id, listed }: { id: string; listed: boolean }): Promise<void> {
    if (listed && !this.host.listable().has(id)) throw new Error("This identity cannot be listed in your DID");
    await this.save(stored => {
      const current = stored!.listed;
      const next = listed ? [...current.filter(x => x !== id), id] : current.filter(x => x !== id);
      try {
        encodeDidDhtPacket(didDhtDocument(this.publicKey(), { alsoKnownAs: this.alsoKnownAs(next) }));
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- a message for the person; ES2020 has no Error.cause.
        if (error instanceof PacketTooLargeError) throw new Error("Your DID has no room for another identity (1000 bytes). Take one out first.");
        throw error;
      }
      return { ...stored!, listed: next };
    });
    this.due = true;
    this.host.emit();
    this.schedule(CHANGE_DELAY_MS);
    this.watchExpiry();
  }

  /** The profile's identities changed (added, removed, expired): publish if the document did. */
  changed(): void {
    if (!this.stored) return;
    const ids = new Set(this.host.proofIds());
    const kept = this.stored.listed.filter(id => ids.has(id));
    if (kept.length !== this.stored.listed.length) {
      this.due = true;
      void this.save(stored => ({ ...stored!, listed: stored!.listed.filter(id => ids.has(id)) })).catch(() => {});
    }
    if (this.stored.published && !this.samePacket(this.stored.published.payload)) this.schedule(CHANGE_DELAY_MS);
    this.watchExpiry();
  }

  /** A listed proof that expires leaves the document then, not at the next hourly put of the old one. */
  private watchExpiry(): void {
    const listable = this.host.listable();
    const ends = this.listed().filter(id => listable.has(id)).map(id => this.host.expiresAt?.(id)).filter((at): at is number => at !== undefined);
    const at = this.running && ends.length ? Math.min(...ends) : undefined;
    if (at === this.expiry?.at) return;
    if (this.expiry) clearTimeout(this.expiry.timer);
    this.expiry = null;
    if (at === undefined) return;
    // A timer holds about 24 days at most: a later expiry is looked at again then. One past it is no longer listable.
    const ms = Math.min(Math.max(0, at - Date.now()) + 1, MAX_TIMEOUT_MS);
    this.expiry = { at, timer: setTimeout(() => { this.expiry = null; this.changed(); }, ms) };
  }

  /**
   * Publishes now (or right after the publish in flight): the hourly timer starts over, or a failed one is tried again in
   * `RETRY_MS`. Settles once what was asked is out: a call while one is on its way waits for the one after it too. It
   * waited for the one on its way alone, and a one-shot's `close` ended with the document as it was before its listing
   * changed (the newer one went after the stop).
   */
  publishNow(): Promise<void> {
    if (this.publishing) { this.again = true; return this.publishing; }
    this.publishing = (async () => {
      try {
        do { this.again = false; await this.publish(); } while (this.again);
      } finally { this.publishing = null; }
      this.scheduleNext();
    })();
    return this.publishing;
  }

  /**
   * After a publish (the timer's or the engine's at network-back): a failed one is tried again in `RETRY_MS`; else the hour
   * starts over. A sooner timer stays: a change made while this publish was on its way is still due in its 2 s.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    const published = this.stored?.published;
    if (this.error) { if (!this.timer || this.timerAt > Date.now() + RETRY_MS) this.schedule(RETRY_MS); }
    else if (!this.timer || (published && this.samePacket(published.payload))) this.schedule(DID_REPUBLISH_MS);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publishNow().catch(() => {});
    }, ms);
  }

  private async publish(): Promise<void> {
    if (!this.stored || this.ended || !this.host.online()) return;
    const previous = this.stored.published;
    try {
      const packet = encodeDidDhtPacket(this.document());
      let payload: Uint8Array;
      let seq: number;
      if (previous && this.samePacket(previous.payload)) {
        // Unchanged: the same signed packet again, which a DHT node or relay takes as a refresh, not an update.
        payload = fromBase64Url(previous.payload);
        seq = previous.seq;
      } else {
        seq = Math.max(Math.floor(Date.now() / 1000), (previous?.seq ?? 0) + 1);
        payload = signDidDhtPacket(identityFromSeed(await this.unsealed()), packet, seq);
      }
      this.signedSeq = Math.max(this.signedSeq, seq);
      await this.host.publish(toZ32(this.publicKey()), payload);
      if (this.ended) return;
      // A listing changed while this one was on its way is still due.
      this.due &&= !this.samePacket(toBase64Url(payload));
      this.error = undefined;
      await this.save(stored => ({ ...stored!, published: { payload: toBase64Url(payload), seq, at: Date.now() } }));
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.host.emit();
  }

  /**
   * "Clear all data": the DID ends. When a document was ever published (or is on its way), a newer packet reading `deactivated` replaces
   * it, so resolvers say the DID is gone instead of showing the old document until it expires. Stops publishing first.
   */
  async deactivate(): Promise<void> {
    this.ended = true;
    this.stop();
    const previous = this.stored?.published;
    // Ever published: saved, or signed and still on its way (its save never comes now).
    if (!this.stored || (!previous && this.signedSeq === 0)) return;
    const seq = Math.max(Math.floor(Date.now() / 1000), (previous?.seq ?? 0) + 1, this.signedSeq + 1);
    const identity = identityFromSeed(fromBase64Url(await openSecret(this.stored.seed, SEED_AT)));
    await this.host.publish(toZ32(this.publicKey()), signDidDhtPacket(identity, encodeDidDhtDeactivated(this.publicKey()), seq));
  }

  private listed(): string[] {
    return this.stored?.listed ?? [];
  }

  private alsoKnownAs(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const listable = this.host.listable();
    return [...new Set(ids.map(id => listable.get(id)).filter((uri): uri is string => !!uri))];
  }

  private publicKey(): Uint8Array {
    if (!this.stored) throw new Error("The profile's DID is not loaded yet");
    return fromBase64Url(this.stored.publicKey);
  }

  /**
   * Whether `payload` carries the document as it is now. Never throws: the engine's state is built from it. Every state
   * asks, and the document follows from the key and its URIs alone, so it is encoded again only when those URIs or `payload` change.
   */
  private samePacket(payload: string, alsoKnownAs = this.alsoKnownAs(this.listed())): boolean {
    const uris = alsoKnownAs.join(" ");
    if (this.compared?.payload === payload && this.compared.uris === uris) return this.compared.same;
    let same = false;
    try {
      same = bytesEqual(fromBase64Url(payload).subarray(HEADER), encodeDidDhtPacket(didDhtDocument(this.publicKey(), { alsoKnownAs })));
    } catch { /* not the same */ }
    this.compared = { payload, uris, same };
    return same;
  }

  /**
   * A copy of the DID key's seed, for the first device-set secret of the profile (WISP 06 § Terms: `D0` comes from
   * it, so every backup of the profile leads to the same turn address). Never published, never stored elsewhere.
   */
  async deviceSetSeed(): Promise<Uint8Array> {
    if (!this.stored) throw new Error("The profile's DID is not loaded");
    return new Uint8Array(await this.unsealed());
  }

  private async unsealed(): Promise<Uint8Array> {
    this.seed ??= fromBase64Url(await openSecret(this.stored!.seed, SEED_AT));
    return this.seed;
  }

  private save(change: (stored: StoredProfileDid | null) => StoredProfileDid): Promise<void> {
    const run = this.saving.then(async () => {
      // Ended by "Clear all data": nothing writes the cleared record back (a late publish, `changed()`, `setListed`).
      if (this.ended) return;
      const next = change(this.stored);
      await committed((await store(STORES.settings, "readwrite")).put(next, KEY));
      this.stored = next;
    });
    this.saving = run.catch(() => {});
    return run;
  }
}
