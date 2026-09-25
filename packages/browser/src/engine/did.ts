import {
  bytesEqual, createIdentity, didDhtDocument, didDhtFromPublicKey, encodeDidDhtPacket, fromBase64Url, identityFromSeed, PacketTooLargeError,
  signDidDhtPacket, toBase64Url, toZ32, type DidDhtDocument,
} from "@ghostly/core";
import { STORES, store, wrap } from "../shared/idb";
import type { ProfileDidView } from "../shared/types";
import { newDeviceKey, sealSeed, unsealSeed } from "./paymentAdapters/persistence";
import type { SealedProofKey } from "./identities";

/**
 * The profile's did:dht (WISP 3xx-did-dht). Ghostly has no profile-wide key (every chat has its own), so
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
  /** Every identity proof id of the profile, listable or not. */
  proofIds(): string[];
  /** Puts a signed packet on Pkarr as is (the relays and, on Desktop, the DHT). */
  publish(pubKeyZ32: string, payload: Uint8Array): Promise<void>;
}

const KEY = "profileDid";
/** Mainline keeps a mutable item about two hours: the same packet goes out again every hour. */
export const DID_REPUBLISH_MS = 60 * 60_000;
/** After start, once the chats had their first go at the relays. */
const FIRST_PUBLISH_MS = 15_000;
/** A few switches flipped in a row make one publish. */
const CHANGE_DELAY_MS = 2_000;
/** A failed publish is tried again this much later (not before the hourly one otherwise). */
const RETRY_MS = 5 * 60_000;
/** Relay payload header: signature and sequence number, before the DNS packet. */
const HEADER = 72;

export class ProfileDid {
  private stored: StoredProfileDid | null = null;
  private seed: Uint8Array | null = null;
  private error: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private again = false;

  constructor(private host: ProfileDidHost) {}

  /** Reads the profile's DID, making its key the first time. */
  async load(): Promise<void> {
    const found = await wrap<StoredProfileDid | undefined>((await store(STORES.settings, "readonly")).get(KEY));
    if (found) { this.stored = found; return; }
    const identity = createIdentity();
    const deviceKey = newDeviceKey();
    const made: StoredProfileDid = {
      seed: { sealed: await sealSeed(identity.seedB64, deviceKey), deviceKey },
      publicKey: toBase64Url(identity.publicKey),
      createdAt: Date.now(),
      listed: [],
    };
    await this.save(made);
    this.seed = identity.seed;
  }

  start(): void {
    this.running = true;
    this.schedule(FIRST_PUBLISH_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
    return {
      id: this.id,
      listed: this.listed(),
      alsoKnownAs: this.alsoKnownAs(this.listed()),
      ...(published ? { published: { at: published.at, versionId: String(published.seq) } } : {}),
      upToDate: !!published && this.samePacket(published.payload),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Lists an identity in the public document, or takes it out. Only identities the profile holds and
   * a document can list; refused when the packet would not fit 1000 bytes.
   */
  async setListed({ id, listed }: { id: string; listed: boolean }): Promise<void> {
    const current = this.listed();
    if (listed && !this.host.listable().has(id)) throw new Error("This identity cannot be listed in your DID");
    const next = listed ? [...current.filter(x => x !== id), id] : current.filter(x => x !== id);
    try {
      encodeDidDhtPacket(didDhtDocument(this.publicKey(), { alsoKnownAs: this.alsoKnownAs(next) }));
    } catch (error) {
      if (error instanceof PacketTooLargeError) throw new Error("Your DID has no room for another identity (1000 bytes). Take one out first.", { cause: error });
      throw error;
    }
    await this.save({ ...this.stored!, listed: next });
    this.host.emit();
    this.schedule(CHANGE_DELAY_MS);
  }

  /** The profile's identities changed (added, removed, expired): publish if the document did. */
  changed(): void {
    if (!this.stored) return;
    const ids = new Set(this.host.proofIds());
    const kept = this.stored.listed.filter(id => ids.has(id));
    if (kept.length !== this.stored.listed.length) void this.save({ ...this.stored, listed: kept }).catch(() => {});
    if (this.stored.published && !this.samePacket(this.stored.published.payload)) this.schedule(CHANGE_DELAY_MS);
  }

  /** Publishes now (or right after the publish in flight): the hourly timer starts over. */
  async publishNow(): Promise<void> {
    if (this.inFlight) { this.again = true; return this.inFlight; }
    this.inFlight = this.publish().finally(() => { this.inFlight = null; });
    await this.inFlight;
    if (this.again) { this.again = false; await this.publishNow(); }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publishNow().finally(() => { if (this.running && !this.timer) this.schedule(this.error ? RETRY_MS : DID_REPUBLISH_MS); });
    }, ms);
  }

  private async publish(): Promise<void> {
    if (!this.stored || !this.host.online()) return;
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
      await this.host.publish(toZ32(this.publicKey()), payload);
      this.error = undefined;
      await this.save({ ...this.stored, published: { payload: toBase64Url(payload), seq, at: Date.now() } });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.host.emit();
  }

  private listed(): string[] {
    return this.stored?.listed ?? [];
  }

  private alsoKnownAs(ids: string[]): string[] {
    const listable = this.host.listable();
    return [...new Set(ids.map(id => listable.get(id)).filter((uri): uri is string => !!uri))];
  }

  private publicKey(): Uint8Array {
    if (!this.stored) throw new Error("The profile's DID is not loaded yet");
    return fromBase64Url(this.stored.publicKey);
  }

  /** Whether `payload` carries the document as it is now. Never throws: the engine's state is built from it. */
  private samePacket(payload: string): boolean {
    try {
      return bytesEqual(fromBase64Url(payload).subarray(HEADER), encodeDidDhtPacket(this.document()));
    } catch {
      return false;
    }
  }

  private async unsealed(): Promise<Uint8Array> {
    this.seed ??= fromBase64Url(await unsealSeed(this.stored!.seed.sealed, this.stored!.seed.deviceKey));
    return this.seed;
  }

  private async save(next: StoredProfileDid): Promise<void> {
    await wrap((await store(STORES.settings, "readwrite")).put(next, KEY));
    this.stored = next;
  }
}
