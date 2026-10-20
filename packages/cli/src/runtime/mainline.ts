import { createHash } from "node:crypto";
import DHT from "bittorrent-dht";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  HEDGE_MISSING_MS, HEDGE_MS, RelayTransport, RelaysFailedError, SLOW_MS, isDiscoveryBudgetError, newerPacket, parseRelayPayload, publicKeyFromZ32,
  type DiscoveryStatus, type GhostRecord, type Identity, type PkarrRequestOptions, type PkarrTransport, type RelayTransportOptions, type SignedPacket,
} from "@ghostly/core";

/**
 * Pkarr over the Mainline DHT (BEP44), from Node, as the Desktop reaches it from Rust: the relays are HTTP bridges to
 * this same DHT, so a headless Ghostly that speaks it directly keeps finding its contacts while the relays fail (they
 * answered HTTP 500 for more than ten minutes on 2026-09-27, and a group's edges stayed down all that while).
 *
 * A Pkarr packet is a BEP44 mutable item: the key is the Ed25519 public key, the value the DNS packet, the sequence
 * number its timestamp in microseconds, and the signature the one the relay payload already carries (over
 * `3:seqi<seq>e1:v<len>:<v>`). So one signed payload goes to the relays and to the DHT unchanged.
 */

export interface MainlineOptions {
  /** `host:port` nodes to start from; the public routers when absent; none with `false` (a testnet's first node). */
  bootstrap?: string[] | false;
  /** Address to bind (a loopback testnet binds 127.0.0.1). */
  host?: string;
  /** How long a lookup may take before it is given up, in ms. */
  timeoutMs?: number;
}

const SIGNATURE = 64, TIMESTAMP = 8;
const verify = (sig: Uint8Array, message: Uint8Array, key: Uint8Array) => { try { return ed25519.verify(sig, message, key); } catch { return false; } };

/** A DHT node of this process: puts and gets Pkarr packets. */
export class Mainline {
  private readonly dht: DHT;
  /** Its UDP socket is bound. */
  readonly listening: Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: MainlineOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    const bootstrap = options.bootstrap === false ? false : options.bootstrap?.length ? options.bootstrap : undefined;
    this.dht = new DHT({ verify, ...(bootstrap !== undefined ? { bootstrap } : {}), ...(options.host ? { host: options.host } : {}) });
    this.listening = new Promise((resolve) => this.dht.listen(0, options.host, () => resolve()));
    // A node of the table that errors must not end the process.
    this.dht.on("error", () => {});
  }

  /** Adds a node (a testnet's peers). */
  addNode(host: string, port: number): void { this.dht.addNode({ host, port }); }
  address(): { port: number } { return this.dht.address() as { port: number }; }

  /** Puts a relay payload (`<signature><timestamp><DNS packet>`) as the mutable item of `pubKeyZ32`; resolves with the nodes that took it. */
  put(pubKeyZ32: string, payload: Uint8Array): Promise<number> {
    const k = Buffer.from(publicKeyFromZ32(pubKeyZ32));
    const sig = Buffer.from(payload.subarray(0, SIGNATURE));
    const seq = Number(new DataView(payload.buffer, payload.byteOffset + SIGNATURE, TIMESTAMP).getBigUint64(0));
    const v = Buffer.from(payload.subarray(SIGNATURE + TIMESTAMP));
    return this.bounded(new Promise((resolve, reject) => {
      this.dht.put({ k, v, seq, sig }, (error, _hash, nodes) => {
        if (error) reject(error); else if (!nodes) reject(new Error("No DHT node took the packet")); else resolve(nodes);
      });
    }));
  }

  /** The newest packet of `pubKeyZ32` the DHT holds, checked; null when nobody has one. */
  get(pubKeyZ32: string): Promise<SignedPacket | null> {
    const k = Buffer.from(publicKeyFromZ32(pubKeyZ32));
    // A mutable item without salt is found under the SHA-1 of its public key (BEP44).
    const target = createHash("sha1").update(k).digest();
    return this.bounded(new Promise((resolve, reject) => {
      this.dht.get(target, { cache: false }, (error, found) => {
        if (error) return reject(error);
        if (!found?.v || !found.sig) return resolve(null);
        const timestamp = new Uint8Array(TIMESTAMP);
        new DataView(timestamp.buffer).setBigUint64(0, BigInt(found.seq));
        const payload = new Uint8Array(SIGNATURE + TIMESTAMP + found.v.length);
        payload.set(found.sig, 0); payload.set(timestamp, SIGNATURE); payload.set(found.v, SIGNATURE + TIMESTAMP);
        try { resolve(parseRelayPayload(pubKeyZ32, payload)); } catch { resolve(null); }
      });
    }));
  }

  private bounded<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DHT lookup timed out")), this.timeoutMs);
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  destroy(): Promise<void> { return new Promise((resolve) => this.dht.destroy(() => resolve())); }
}

/** Keys a `RelaysAndDht` remembers as found nowhere (`missing`). */
const MISSING_KEPT = 256;

/**
 * The relays first, as the web app reaches Pkarr (its contacts read only the relays), and the DHT beside them: every
 * packet also goes to the DHT, and a read goes there when every relay is failing, the read failed, or this app's own
 * request budget held it back (the DHT has no budget). A background read the budget holds waits for it.
 *
 * `pinned`: the relays given are the only ones (`GHOSTLY_PKARR_RELAYS`, a private network): the profile's `relays`
 * setting does not replace them. With no DHT (`dht` null), the relays alone carry every packet.
 */
export class RelaysAndDht implements PkarrTransport {
  readonly relays: RelayTransport;
  private lastVia: "relay" | "dht" = "relay";
  /**
   * Keys a hedged read found nowhere: the DHT said so before the relays' slow 404 came, so the next poll of the key
   * hedges late too (`HEDGE_MISSING_MS`), not only once that 404 lands. The newest `MISSING_KEPT`.
   */
  private readonly missing = new Set<string>();

  constructor(private readonly dht: Mainline | null, relays: RelayTransportOptions = {}, private readonly pinned = false) {
    this.relays = new RelayTransport(relays);
  }

  async publish(identity: Identity, records: GhostRecord[], options: PkarrRequestOptions = {}): Promise<void> {
    // BEP44 sequence numbers must strictly increase, on the relays and on the DHT alike: one payload for both, dated
    // past every packet put or read under the key (`RelayTransport.publishDated`), whichever clock dated those.
    // With the DHT, the packet goes there whatever the relays' budgets say: signed every time. Without it (a private
    // network's relays only), a publish none of them takes now is not signed at all.
    await this.relays.publishDated(identity, records, (key, payload, timestamp, conflict) => this.putBoth(key, payload, options, conflict, timestamp), options, false, this.dht !== null);
  }

  publishPayload(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions = {}): Promise<void> {
    return this.putBoth(pubKeyZ32, payload, options);
  }

  /**
   * `timestamp`: the payload was just signed here (`publish`), dated so; its signature is not checked again on the way
   * to the relays. Without it (`publishPayload`, signed elsewhere) the relays' side checks it to read its date.
   */
  private async putBoth(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions, conflict?: (relay: string) => void, timestamp?: bigint): Promise<void> {
    const toRelays = () => timestamp === undefined
      ? this.relays.publishPayload(pubKeyZ32, payload, options, conflict)
      : this.relays.putSigned(pubKeyZ32, payload, timestamp, options, conflict);
    if (!this.dht) return toRelays();
    const onDht = this.dht.put(pubKeyZ32, payload);
    onDht.catch(() => {});
    const onRelays = toRelays();
    onRelays.catch(() => {});
    // Out on the DHT is out (a Pkarr relay reads the DHT for a key it has not got): a relay that takes the request and
    // never answers held each publish for its 10 s timeout, an invite's first among them, while the DHT took it in
    // milliseconds. The relays' copy finishes in the background. A budget's hold is said before any request goes, so
    // it still wins this race: the caller tries again, and the relays take it when it frees (browser contacts read only them).
    const tookIt = onDht.then(() => true, () => false);
    if (await Promise.race([onRelays.then(() => false, () => false), tookIt])) return;
    try {
      await onRelays;
    } catch (error) {
      if (isDiscoveryBudgetError(error)) throw error;
      // The relays failed: the DHT's answer is the publish's.
      if (!(await tookIt)) throw error;
    }
  }

  async resolve(pubKeyZ32: string, options: PkarrRequestOptions = {}): Promise<SignedPacket | null> {
    if (!this.dht) return this.relays.resolve(pubKeyZ32, options);
    let fromRelays: SignedPacket | null = null, failed: unknown = null;
    // Every relay left alone for failing: the relays answer from what they last saw, if anything; the DHT is asked.
    const down = () => this.relays.discovery().relays.every((relay) => relay.state === "failing");
    if (!down()) {
      const started = Date.now();
      // A read the relays failed asks the DHT at once, their last copy kept to weigh against its packet. Handed back
      // as their answer, it stood for each 20 s cooldown until the breaker opened: about 40 s of a contact's old packet
      // with the newer one on the DHT (bug hunt, 2026-10-17).
      const relays = this.relays.resolve(pubKeyZ32, options, false).then((packet) => ({ packet, failed: null as unknown }), (error: unknown) => ({ packet: null, failed: error }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A key whose last read found nothing: the relays take 3-5 s to say a key is not there
      // (they ask the DHT themselves), and a hedge at HEDGE_MS made every poll of an unused invite's key a DHT lookup
      // of its own (+47 in 10 min: agents#1595). Their own hedge waits as long (`RelayTransport`, `HEDGE_MISSING_MS`).
      const hedgeAfter = this.relays.lastReadMissing(pubKeyZ32) || this.missing.has(pubKeyZ32) ? HEDGE_MISSING_MS : HEDGE_MS;
      const answered = await Promise.race([relays, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), hedgeAfter); })]);
      clearTimeout(timer);
      // The relays have not answered within a hedge's time (one that takes requests and never answers held each read
      // for its 10 s timeout): the DHT is asked too.
      if (!answered) {
        const found = await this.hedged(pubKeyZ32, relays, started);
        this.missing.delete(pubKeyZ32);
        if (!found) { this.missing.add(pubKeyZ32); if (this.missing.size > MISSING_KEPT) this.missing.delete(this.missing.values().next().value!); }
        return found;
      }
      ({ packet: fromRelays, failed } = answered);
      // The relays' budget held the read back: the DHT, which has no budget and already has a contact's first
      // envelope, is asked instead. Waiting for the relays' minute made each pairing past ~10 chats on working relays
      // take 3-18 s (13-37 s on one relay), where DHT-only pairings take 0.1-2.8 s (agents#1715). Found nowhere there,
      // or a background read, it is still a wait.
      if (isDiscoveryBudgetError(failed)) return this.heldBack(pubKeyZ32, failed, options);
      if (failed instanceof RelaysFailedError) fromRelays = failed.kept;
      if (!failed) this.lastVia = "relay";
      if (!failed && !down()) return fromRelays;
    }
    try {
      const fromDht = await this.fromDht(pubKeyZ32);
      this.lastVia = "dht";
      return newerPacket(fromRelays, fromDht);
    } catch (error) {
      if (fromRelays) return fromRelays;
      throw failed ?? error;
    }
  }

  private async heldBack(pubKeyZ32: string, held: unknown, options: PkarrRequestOptions): Promise<SignedPacket> {
    if (options.background) throw held;
    const fromDht = await this.fromDht(pubKeyZ32).catch(() => null);
    if (!fromDht) throw held;
    this.lastVia = "dht";
    return fromDht;
  }

  private async fromDht(pubKeyZ32: string): Promise<SignedPacket | null> {
    const packet = await this.dht!.get(pubKeyZ32);
    if (packet) this.relays.sawTimestamp(pubKeyZ32, packet.timestampMicros);
    return packet;
  }

  /**
   * A read the relays are slow to answer, the DHT asked beside them. The relays' packet first is the answer, as without
   * the hedge. The DHT's first waits for the relays until a slow relay would have had its say (`SLOW_MS`, a relay
   * fetching the packet from the DHT itself), or until they answer, and the newer of the two is the answer: taken at
   * once, the DHT's older copy won every read over a relay that took 2 s with the newer one (agents#1594). The DHT
   * finding none is the answer once that time is up too, or once the relays answered. Both failing: the relays' reason.
   */
  private async hedged(pubKeyZ32: string, relays: Promise<{ packet: SignedPacket | null; failed: unknown }>, started: number): Promise<SignedPacket | null> {
    const dht = this.fromDht(pubKeyZ32).then((packet) => ({ packet, failed: null as unknown, via: "dht" as const }), (error: unknown) => ({ packet: null, failed: error, via: "dht" as const }));
    const viaRelays = relays.then((r) => ({ ...r, via: "relay" as const }));
    const first = await Promise.race([viaRelays, dht]);
    if (first.packet && first.via === "relay") { this.lastVia = "relay"; return first.packet; }
    const fromDht = await dht;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slowAfter = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, SLOW_MS - (Date.now() - started))); });
    const fromRelays = await Promise.race([viaRelays, slowAfter]);
    clearTimeout(timer);
    if (fromDht.packet) {
      const newer = newerPacket(fromRelays?.packet, fromDht.packet);
      this.lastVia = newer === fromDht.packet ? "dht" : "relay";
      return newer;
    }
    if (fromRelays?.packet) { this.lastVia = "relay"; return fromRelays.packet; }
    if (!fromDht.failed) { this.lastVia = "dht"; return null; }
    if (!fromRelays) throw fromDht.failed;
    if (!fromRelays.failed) return null;
    throw fromRelays.failed;
  }

  describe(): { protocol: string; relays: string[] } {
    return { protocol: this.dht ? "Pkarr relays (HTTP), and the Mainline DHT (BEP44) directly" : "Pkarr relays (HTTP)", relays: this.relays.describe().relays };
  }
  discovery(): DiscoveryStatus {
    const status = this.relays.discovery();
    return this.lastVia === "dht" ? { ...status, path: { via: "dht" } } : status;
  }
  subscribe(listener: Parameters<RelayTransport["subscribe"]>[0]): () => void { return this.relays.subscribe(listener); }
  /** A relay's answer only: a packet the DHT hands back when the relays are down may be older than one already read. */
  readAnsweredAt(pubKeyZ32: string): number | undefined { return this.relays.readAnsweredAt(pubKeyZ32); }
  readHeldBackFor(pubKeyZ32: string): number | undefined { return this.relays.readHeldBackFor(pubKeyZ32); }
  onServerTime(listener: Parameters<RelayTransport["onServerTime"]>[0]): () => void { return this.relays.onServerTime(listener); }
  configure({ relays }: { relays: string[]; readRelays: boolean }): void { if (!this.pinned) this.relays.setRelays(relays); }
}
