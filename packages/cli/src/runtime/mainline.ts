import { createHash } from "node:crypto";
import DHT from "bittorrent-dht";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  RelayTransport, createRelayPayload, isDiscoveryBudgetError, newerPacket, parseRelayPayload, publicKeyFromZ32,
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

/**
 * The relays first, as the web app reaches Pkarr (its contacts read only the relays), and the DHT beside them: every
 * packet also goes to the DHT, and a read goes there when every relay is failing or the read failed for anything but
 * this app's own request budget (that is a wait, not an outage).
 */
export class RelaysAndDht implements PkarrTransport {
  readonly relays: RelayTransport;
  private readonly lastTimestamp = new Map<string, bigint>();
  private lastVia: "relay" | "dht" = "relay";

  constructor(private readonly dht: Mainline, relays: RelayTransportOptions = {}) {
    this.relays = new RelayTransport(relays);
  }

  async publish(identity: Identity, records: GhostRecord[], options: PkarrRequestOptions = {}): Promise<void> {
    // BEP44 sequence numbers must strictly increase, on the relays and on the DHT alike: one payload for both.
    const now = BigInt(Date.now()) * 1000n, last = this.lastTimestamp.get(identity.pubKeyZ32) ?? 0n;
    const timestamp = now > last ? now : last + 1n;
    this.lastTimestamp.set(identity.pubKeyZ32, timestamp);
    await this.publishPayload(identity.pubKeyZ32, createRelayPayload(identity, records, timestamp), options);
  }

  async publishPayload(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions = {}): Promise<void> {
    const onDht = this.dht.put(pubKeyZ32, payload);
    onDht.catch(() => {});
    try {
      await this.relays.publishPayload(pubKeyZ32, payload, options);
    } catch (error) {
      // Held back by this app's budget: the relays take it when it frees (browser contacts read only them).
      if (isDiscoveryBudgetError(error)) throw error;
      // The relays failed: out on the DHT is out (a Pkarr relay reads the DHT for a key it has not got).
      await onDht.catch(() => { throw error; });
    }
  }

  async resolve(pubKeyZ32: string, options: PkarrRequestOptions = {}): Promise<SignedPacket | null> {
    let fromRelays: SignedPacket | null = null, failed: unknown = null;
    // Every relay left alone for failing: the relays answer from what they last saw, if anything; the DHT is asked.
    const down = () => this.relays.discovery().relays.every((relay) => relay.state === "failing");
    if (!down()) {
      try { fromRelays = await this.relays.resolve(pubKeyZ32, options); this.lastVia = "relay"; } catch (error) {
        if (isDiscoveryBudgetError(error)) throw error;
        failed = error;
      }
      if (!failed && !down()) return fromRelays;
    }
    try {
      const fromDht = await this.dht.get(pubKeyZ32);
      this.lastVia = "dht";
      return newerPacket(fromRelays, fromDht);
    } catch (error) {
      if (fromRelays) return fromRelays;
      throw failed ?? error;
    }
  }

  describe(): { protocol: string; relays: string[] } {
    return { protocol: "Pkarr relays (HTTP), and the Mainline DHT (BEP44) directly", relays: this.relays.describe().relays };
  }
  discovery(): DiscoveryStatus {
    const status = this.relays.discovery();
    return this.lastVia === "dht" ? { ...status, path: { via: "dht" } } : status;
  }
  subscribe(listener: Parameters<RelayTransport["subscribe"]>[0]): () => void { return this.relays.subscribe(listener); }
  configure({ relays }: { relays: string[]; readRelays: boolean }): void { this.relays.setRelays(relays); }
}
