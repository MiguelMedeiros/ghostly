import { createHash } from "node:crypto";
import DHT from "bittorrent-dht";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  BACKGROUND_REQUESTS_PER_MINUTE, DiscoveryBudgetError, HEDGE_MISSING_MS, HEDGE_MS, RelayTransport, RelaysFailedError, SLOW_MS, isDiscoveryBudgetError, newerPacket, parseRelayPayload, publicKeyFromZ32,
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
/**
 * What a `get` takes from the nodes that answer: a record signed without salt (Pkarr has none). bittorrent-dht reads a
 * reply's `salt` (`Buffer.concat` with the key) only once it is verified, and a number there threw in its socket handler:
 * any node a lookup asked, signing with its own key, raised an error nobody caught. Signed data is `4:salt…` with a salt.
 */
const SALTED = Buffer.from("4:salt");
const verifyUnsalted = (sig: Uint8Array, message: Uint8Array, key: Uint8Array) =>
  !Buffer.from(message.buffer, message.byteOffset, Math.min(message.length, SALTED.length)).equals(SALTED) && verify(sig, message, key);

/** Queries the node answers, a second: from each address (as libtorrent's default), and from all of them together. */
const QUERY_LIMITS = { perAddress: 5, perAddressBurst: 20, total: 50, totalBurst: 200 };
/** Addresses `DhtQueryLimit` remembers: forged source addresses must not grow it without end. */
const ADDRESSES_KEPT = 4_096;
/** Mutable items others put on the node: as many as bittorrent-dht keeps, each for the two hours BEP44 suggests. */
const VALUES_KEPT = { max: 1_000, maxAge: 2 * 60 * 60_000 };

/**
 * The queries a DHT node answers, as token buckets: a burst then a rate per source address, and a total for all. UDP
 * has no handshake, so a query's address can be someone else's: answered without a limit, a stranger who parked a
 * 1000-byte item on the node had it send ~12.5x the bytes of each forged `get` (5-6x with nothing parked) to that
 * address, as fast as they came. Queries past either limit go unanswered, as an overloaded node's do. This node's own
 * lookups (answers to its queries, not queries) are not counted.
 */
export class DhtQueryLimit {
  private readonly addresses = new Map<string, { tokens: number; at: number }>();
  private all: { tokens: number; at: number } | null = null;

  constructor(private readonly limits: typeof QUERY_LIMITS = QUERY_LIMITS) {}

  /** Addresses remembered (`ADDRESSES_KEPT` at most). */
  get size(): number { return this.addresses.size; }

  /** Whether a query from `host` is answered now (counted if so). */
  take(host: string, now = Date.now()): boolean {
    const refill = (bucket: { tokens: number; at: number } | null | undefined, rate: number, burst: number) => {
      if (!bucket) return { tokens: burst, at: now };
      // A clock that went back refills nothing, and counts from now on.
      bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1_000);
      bucket.at = now;
      return bucket;
    };
    const all = this.all = refill(this.all, this.limits.total, this.limits.totalBurst);
    const own = refill(this.addresses.get(host), this.limits.perAddress, this.limits.perAddressBurst);
    // Kept in the order last asked: the address not heard from the longest goes first.
    this.addresses.delete(host);
    this.addresses.set(host, own);
    if (this.addresses.size > ADDRESSES_KEPT) this.addresses.delete(this.addresses.keys().next().value!);
    if (own.tokens < 1 || all.tokens < 1) return false;
    own.tokens -= 1; all.tokens -= 1;
    return true;
  }
}

type Query = { q?: Buffer | string; a?: { k?: unknown; v?: unknown; seq?: unknown; sig?: unknown; salt?: unknown; target?: unknown; info_hash?: unknown } };
type QueryPeer = { address: string; port: number };
/** The parts of bittorrent-dht's node (no API for them) through which it answers queries. */
interface DhtInternals { _onquery(query: Query, peer: QueryPeer): void; _rpc: { error(peer: QueryPeer, query: Query, error: [number, string]): void } }

/**
 * A source on loopback is this machine, never a forged address from outside (a packet from the network claiming one is
 * dropped before it gets here): each of its ports is a node of its own (a loopback testnet's nodes all share the host),
 * counted apart. Any other address is counted whatever its port, as a forged source's port is the sender's choice.
 */
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const bytes = (value: unknown, length: number): boolean => Buffer.isBuffer(value) && value.length === length;
/** BEP44's bound on an item's value, which bittorrent-dht checks only on what has a `length` (not a dictionary). */
const VALUE_MAX = 1_000;

/**
 * What the node answers strangers: queries at `DhtQueryLimit`'s rate, ping, find_node and get/get_peers as BEP5/BEP44
 * say, and puts of signed mutable items only, which is what Pkarr packets are (the testnet's nodes and the public DHT
 * keep each other's that way). It refuses what the app has no use for and bittorrent-dht kept for anyone and served to
 * anyone: immutable items and peers announced for torrents. A put's value is a string of at most 1000 bytes and its seq
 * a non-negative integer, as every Pkarr packet's: bittorrent-dht bounds only a value with a `length`, so a dictionary
 * of 60 KB was kept and served whole to every get. A query whose hash, key, signature or salt is not the string
 * BEP5/BEP44 say (a put signed without a key, a number for a target) threw out of the socket handler: an error nobody
 * caught, one per datagram. It is refused before bittorrent-dht reads it.
 */
function answerBounded(dht: DHT, limit = new DhtQueryLimit()): void {
  const node = dht as unknown as DhtInternals;
  const answer = node._onquery.bind(dht);
  node._onquery = (query, peer) => {
    if (!query || !peer || !limit.take(LOOPBACK.test(peer.address) ? `${peer.address}:${peer.port}` : peer.address)) return;
    const q = query.q?.toString(), a = query.a ?? {};
    if (q === "announce_peer") return node._rpc.error(peer, query, [204, "announce_peer is not served here"]);
    if (q === "put" && (!bytes(a.k, 32) || !bytes(a.sig, SIGNATURE))) return node._rpc.error(peer, query, [203, "only signed mutable items are stored here"]);
    if (q === "put" && !(Buffer.isBuffer(a.v) && a.v.length <= VALUE_MAX)) return node._rpc.error(peer, query, [205, "only values of at most 1000 bytes are stored here"]);
    const malformed = ((q === "get" || q === "find_node") && !bytes(a.target, 20)) || (q === "get_peers" && !bytes(a.info_hash, 20))
      || (q === "put" && !(Number.isSafeInteger(a.seq) && (a.seq as number) >= 0))
      || (q === "put" && a.salt !== undefined && !(Buffer.isBuffer(a.salt) && a.salt.length <= 64));
    if (malformed) return node._rpc.error(peer, query, [203, "malformed query"]);
    try { answer(query, peer); } catch { /* a query bittorrent-dht could not read goes unanswered */ }
  };
}

/**
 * Every DHT node asked refused a put for holding a later-dated packet of the key (BEP44 error 302, "sequence number less
 * than current"): one put by this key's earlier clock, ahead of this one, before a restart forgot its date.
 */
export class DhtRefusedError extends Error {
  constructor(reason: string) {
    super(`The DHT holds a later-dated packet of this key (${reason})`);
    this.name = "DhtRefusedError";
  }
}

/**
 * A DHT node of this process: puts and gets Pkarr packets. The node starts at the first thing asked of it: a command
 * that reads only the profile (`chat list`, `settings get`) or a profile set offline asks nothing, and before, every
 * command bound a UDP port and bootstrapped from the public routers all the same, sending them this machine's address.
 */
export class Mainline {
  private node: { dht: DHT; listening: Promise<void> } | null = null;
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: MainlineOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private get dht(): DHT { return this.started().dht; }

  private started(): { dht: DHT; listening: Promise<void> } {
    if (this.closed) throw new Error("The DHT node is closed");
    if (this.node) return this.node;
    const { host } = this.options;
    const bootstrap = this.options.bootstrap === false ? false : this.options.bootstrap?.length ? this.options.bootstrap : undefined;
    // `maxValues` reaches the `lru` that holds others' items, which takes `{ max, maxAge }` as well as a number.
    const dht = new DHT({ verify, maxValues: VALUES_KEPT, ...(bootstrap !== undefined ? { bootstrap } : {}), ...(host ? { host } : {}) });
    // A node of the table that errors must not end the process.
    dht.on("error", () => {});
    answerBounded(dht);
    this.node = { dht, listening: new Promise((resolve) => dht.listen(0, host, () => resolve())) };
    return this.node;
  }

  /** Whether the node started (something was put, got or added). */
  get running(): boolean { return this.node !== null; }
  /** Its UDP socket is bound (starts the node). */
  get listening(): Promise<void> { return this.started().listening; }

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
        if (error) reject((error as Error & { code?: unknown }).code === 302 ? new DhtRefusedError(error.message) : error);
        else if (!nodes) reject(new Error("No DHT node took the packet")); else resolve(nodes);
      });
    }));
  }

  /** The newest packet of `pubKeyZ32` the DHT holds, checked; null when nobody has one. */
  get(pubKeyZ32: string): Promise<SignedPacket | null> {
    const k = Buffer.from(publicKeyFromZ32(pubKeyZ32));
    // A mutable item without salt is found under the SHA-1 of its public key (BEP44).
    const target = createHash("sha1").update(k).digest();
    return this.bounded(new Promise((resolve, reject) => {
      this.dht.get(target, { cache: false, verify: verifyUnsalted }, (error, found) => {
        if (error) return reject(error);
        // A record is what its node sent, checked only by its signature: one signed with no `seq` (bittorrent-dht signs
        // `seq || 0`) or with a dictionary for `v` threw here, out of the socket's handler.
        if (!found || !Buffer.isBuffer(found.v) || !Buffer.isBuffer(found.sig) || !Number.isSafeInteger(found.seq) || found.seq < 0) return resolve(null);
        try {
          const timestamp = new Uint8Array(TIMESTAMP);
          new DataView(timestamp.buffer).setBigUint64(0, BigInt(found.seq));
          const payload = new Uint8Array(SIGNATURE + TIMESTAMP + found.v.length);
          payload.set(found.sig, 0); payload.set(timestamp, SIGNATURE); payload.set(found.v, SIGNATURE + TIMESTAMP);
          resolve(parseRelayPayload(pubKeyZ32, payload));
        } catch { resolve(null); }
      });
    }));
  }

  private bounded<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DHT lookup timed out")), this.timeoutMs);
      work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  /** Closes the node and its socket, if it started; the next thing asked of it starts it again. */
  stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    return node ? new Promise((resolve) => node.dht.destroy(() => resolve())) : Promise.resolve();
  }

  destroy(): Promise<void> {
    this.closed = true;
    return this.stop();
  }
}

/** Keys a `RelaysAndDht` remembers as found nowhere (`missing`). */
const MISSING_KEPT = 256;

/** How long a key that asked for a background DHT read counts among those that share the budget (`DhtBackgroundBudget`). */
const ASKERS_WINDOW_MS = 2 * 60_000;
/** The same for a background DHT write: past a chat's 4-minute upkeep, with room for its turn (a control envelope's life). */
const WRITERS_WINDOW_MS = 10 * 60_000;
const MINUTE_MS = 60_000;

/**
 * Background reads that go to the DHT in the relays' place (every relay failing, or failing this read), within the share
 * the relays would have given them (`BACKGROUND_REQUESTS_PER_MINUTE` a minute on each relay): a minute's lookups at
 * most, and each key in its turn, no sooner than the keys asking share that minute (`n` keys at `perMinute` a minute:
 * once every `n / perMinute` minutes). Without it, a daemon looked up every contact away on the DHT four times a minute
 * for as long as the relays failed (200 lookups a minute at 50 contacts, 1,200 at 300), where with the relays up it
 * made 26-54 relay reads a minute in all; each lookup on the real DHT is dozens of UDP queries.
 * Reads someone waits on (not `background`, or `urgent`, `signal`, `door`, `resume`) never wait for it, nor count.
 */
export class DhtBackgroundBudget {
  private readonly spent: number[] = [];
  /** Per key, when it last asked (oldest first) and when its last lookup went. */
  private readonly askedAt = new Map<string, number>();
  private readonly lookedAt = new Map<string, number>();
  /** The time of the last `take`: none of the above is dated after it. */
  private latest = -Infinity;

  /** `askersWindowMs`: how long a key counts among those sharing the budget since it last asked (`ASKERS_WINDOW_MS`). */
  constructor(private readonly perMinute: () => number, private readonly askersWindowMs = ASKERS_WINDOW_MS) {}

  /** 0: the lookup goes now (counted). Otherwise how long until this key's turn, in ms; nothing is counted. */
  take(pubKeyZ32: string, now = Date.now()): number {
    // The clock went back (an NTP step, a clock that ran ahead fixed by hand): what is dated after now counts as of now,
    // as just spent. Counted as it was, an hour's step back held every key's lookup for 56 minutes (bug hunt, 2026-11-07).
    if (now < this.latest) {
      this.spent.forEach((at, i) => { this.spent[i] = Math.min(at, now); });
      for (const times of [this.askedAt, this.lookedAt]) for (const [key, at] of times) if (at > now) times.set(key, now);
    }
    this.latest = now;
    this.askedAt.delete(pubKeyZ32);
    this.askedAt.set(pubKeyZ32, now);
    for (const [key, at] of this.askedAt) {
      if (now - at < this.askersWindowMs) break;
      this.askedAt.delete(key);
      this.lookedAt.delete(key);
    }
    while (this.spent.length && now - this.spent[0]! >= MINUTE_MS) this.spent.shift();
    const limit = Math.max(1, this.perMinute());
    const turn = Math.ceil(this.askedAt.size * MINUTE_MS / limit);
    const last = this.lookedAt.get(pubKeyZ32);
    const ownTurn = last === undefined ? 0 : last + turn - now;
    // The minute's lookups are spent (keys new to it, all at once): this key's turn, or the minute's next free one if later.
    const minute = this.spent.length >= limit ? this.spent[0]! + MINUTE_MS - now : 0;
    if (ownTurn > 0 || minute > 0) return Math.max(ownTurn, minute, last === undefined ? turn : 0);
    this.spent.push(now);
    this.lookedAt.set(pubKeyZ32, now);
    return 0;
  }
}

/** A read nobody waits on: what the relays' budget calls background, and what the DHT's (`DhtBackgroundBudget`) holds. */
const waitable = (options: PkarrRequestOptions): boolean =>
  !!options.background && !options.urgent && !options.signal && !options.door && !options.resume;

/**
 * The relays first, as the web app reaches Pkarr (its contacts read only the relays), and the DHT beside them: every
 * packet also goes to the DHT, and a read goes there when every relay is failing, the read failed, or this app's own
 * request budget held it back (the DHT has no budget), or every relay rate limits this address (429). A background read
 * this app's budget holds waits for it. Background reads the DHT answers in the relays' place keep to the relays'
 * background share (`DhtBackgroundBudget`), and so do background writes on the DHT: one past it goes to the relays alone.
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
  /** Background reads on the DHT in the relays' place, at their background share (`DhtBackgroundBudget`). */
  private readonly dhtBackground = new DhtBackgroundBudget(() => BACKGROUND_REQUESTS_PER_MINUTE * this.relays.describe().relays.length);
  /**
   * Background writes on the DHT (upkeep nobody waits on: a chat's heartbeat and keep-alive while its contact is away)
   * at the same share. Without it, every chat put two packets there every 4 minutes for as long as the daemon ran,
   * whatever the relays' budget held of the same: ~104 puts a minute at 200 chats, each a whole iterative lookup.
   * A key counts among those sharing it for longer than a read's (`WRITERS_WINDOW_MS`): one that went asks again only
   * at the next upkeep, 4 minutes on, and forgotten by then it came back as new, without its turn: some chats were put
   * every 4 minutes and others not once in 25.
   * `writeTurns`: keys whose write `publishHeld` let go, not counted again when the publish comes.
   */
  private readonly dhtBackgroundWrites = new DhtBackgroundBudget(() => BACKGROUND_REQUESTS_PER_MINUTE * this.relays.describe().relays.length, WRITERS_WINDOW_MS);
  private readonly writeTurns = new Set<string>();

  /** Off while the profile keeps to the relays (Hide my IP from contacts, `configure`'s `dhtDirect: false`). */
  private direct = true;

  constructor(private readonly mainline: Mainline | null, relays: RelayTransportOptions = {}, private readonly pinned = false) {
    this.relays = new RelayTransport(relays);
  }

  /** The DHT this transport reaches now: none while the profile keeps to the relays. */
  private get dht(): Mainline | null { return this.direct ? this.mainline : null; }

  async publish(identity: Identity, records: GhostRecord[], options: PkarrRequestOptions = {}): Promise<void> {
    // BEP44 sequence numbers must strictly increase, on the relays and on the DHT alike: one payload for both, dated
    // past every packet put or read under the key (`RelayTransport.publishDated`), whichever clock dated those.
    // With the DHT, the packet goes there whatever the relays' budgets say: signed every time. Without it (a private
    // network's relays only), a publish none of them takes now is not signed at all. A background write the DHT's
    // share holds goes to the relays alone, as without the DHT.
    const toDht = this.dht !== null && this.dhtWriteWait(identity.pubKeyZ32, options) === 0;
    await this.relays.publishDated(identity, records, (key, payload, timestamp, conflict) => this.putBoth(key, payload, options, conflict, timestamp, toDht), options, false, toDht);
  }

  publishPayload(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions = {}): Promise<void> {
    return this.putBoth(pubKeyZ32, payload, options, undefined, undefined, this.dhtWriteWait(pubKeyZ32, options) === 0);
  }

  /**
   * 0: this write goes to the DHT now (a background one counted in its share, unless `publishHeld` already let it go).
   * Otherwise how long until its turn there. Writes someone waits on never wait for it, nor count; with no relay set at
   * all the DHT is the only way.
   */
  private dhtWriteWait(pubKeyZ32: string, options: PkarrRequestOptions, ahead = false): number {
    if (!this.dht || !waitable(options) || this.relays.describe().relays.length === 0) return 0;
    if (this.writeTurns.delete(pubKeyZ32)) return 0;
    const wait = this.dhtBackgroundWrites.take(pubKeyZ32);
    if (ahead && wait === 0) this.writeTurns.add(pubKeyZ32);
    return wait;
  }

  /**
   * `timestamp`: the payload was just signed here (`publish`), dated so; its signature is not checked again on the way
   * to the relays. Without it (`publishPayload`, signed elsewhere) the relays' side checks it to read its date.
   * `toDht` false: the relays alone (a background write the DHT's share holds).
   */
  private async putBoth(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions, conflict?: (relay: string, read?: () => Promise<bigint | null>) => void, timestamp?: bigint, toDht = true): Promise<void> {
    const toRelays = () => timestamp === undefined
      ? this.relays.publishPayload(pubKeyZ32, payload, options, conflict)
      : this.relays.putSigned(pubKeyZ32, payload, timestamp, options, conflict);
    if (!this.dht || !toDht) return toRelays();
    const onDht = this.dht.put(pubKeyZ32, payload);
    onDht.catch(() => {});
    const onRelays = toRelays();
    onRelays.catch(() => {});
    // Out on the DHT is out (a Pkarr relay reads the DHT for a key it has not got): a relay that takes the request and
    // never answers held each publish for its 10 s timeout, an invite's first among them, while the DHT took it in
    // milliseconds. The relays' copy finishes in the background. A budget's hold is said before any request goes, so
    // it wins this race: once the DHT took the packet, that is out too, and the relays get it when their budget frees
    // (`putLater`; browser contacts read only them). Said held back, the link signed it and put it on the DHT again in
    // 0.25-4 s, at budget 1.5-2.2x the DHT puts of a DHT-only daemon.
    let refused: unknown;
    const tookIt = onDht.then(() => true, (error: unknown) => {
      refused = error;
      // The DHT holds a later-dated packet of this key, as a relay that answers 409 does: its date is read there, and
      // the records go again dated just past it (`publishDated`). After a clock that ran ahead was set right, a
      // restarted CLI had every put refused, tried again every 4 s until the clock caught up (15 a minute per chat), and
      // texts to a contact away stayed queued.
      if (error instanceof DhtRefusedError) conflict?.("dht", () => this.fromDht(pubKeyZ32).then((packet) => packet?.timestampMicros ?? null));
      return false;
    });
    if (await Promise.race([onRelays.then(() => false, () => false), tookIt])) return;
    try {
      await onRelays;
    } catch (error) {
      if (isDiscoveryBudgetError(error)) {
        if (!(await tookIt)) throw error;
        this.relays.putLater(pubKeyZ32, payload, timestamp, options);
        return;
      }
      // The relays failed: the DHT's answer is the publish's, and its refusal is said with theirs.
      if (!(await tookIt)) throw refused instanceof Error ? new Error(`${error instanceof Error ? error.message : String(error)}; ${refused.message}`, { cause: error }) : error;
    }
  }

  async resolve(pubKeyZ32: string, options: PkarrRequestOptions = {}, keptOnFailure = true): Promise<SignedPacket | null> {
    if (!this.dht) return this.relays.resolve(pubKeyZ32, options, keptOnFailure);
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
      // No relay is asked now: each one rate limits this address (429) for as long as it said, or fails. Their answer is
      // what they last saw, or a wait, and the DHT is asked in their place, as when they all fail (a background read
      // at their share). Taken as their answer, a daemon whose relays answered 429 for 10 minutes read none of its 50
      // contacts in that time, and looked none up on the DHT (bug hunt, 2026-11-11).
      const refusing = this.relays.discovery().relays.every((relay) => relay.state !== "ok");
      // The relays' budget held the read back: the DHT, which has no budget and already has a contact's first
      // envelope, is asked instead. Waiting for the relays' minute made each pairing past ~10 chats on working relays
      // take 3-18 s (13-37 s on one relay), where DHT-only pairings take 0.1-2.8 s (agents#1715). Found nowhere there,
      // or a background read, it is still a wait.
      if (isDiscoveryBudgetError(failed) && !(refusing && options.background)) return this.heldBack(pubKeyZ32, failed, options);
      if (failed instanceof RelaysFailedError) fromRelays = failed.kept;
      if (!failed) this.lastVia = "relay";
      if (!failed && !down() && !refusing) return fromRelays;
    }
    try {
      // A background read the DHT answers instead of the relays waits its turn there (`DhtBackgroundBudget`), as it did
      // on them: held back, as their budget holds one. With no relay set at all the DHT is the only way, not a stand-in.
      if (waitable(options) && this.relays.describe().relays.length > 0) {
        const wait = this.dhtBackground.take(pubKeyZ32);
        if (wait > 0) throw new DiscoveryBudgetError(wait, "Background DHT reads in the relays' place are at their share; retry shortly");
      }
      const fromDht = await this.fromDht(pubKeyZ32);
      this.lastVia = "dht";
      return newerPacket(fromRelays, fromDht);
    } catch (error) {
      // Nothing answered, the DHT neither: the relays' last copy is the answer, or, for a caller that asks, the failure
      // that carries it (`keptOnFailure`).
      if (fromRelays && (keptOnFailure || !(failed instanceof RelaysFailedError))) return fromRelays;
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
    // The switch turned while a read was on its way to the DHT: it does not go.
    if (!this.dht) throw new Error("The DHT is not reached while the profile keeps to the relays");
    const packet = await this.dht.get(pubKeyZ32);
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
  /**
   * With the DHT a packet goes there too, whatever the relays' budgets say: nothing is held, but a background write past
   * the DHT's share (`dhtBackgroundWrites`), which goes to the relays alone and is held as they say.
   */
  publishHeld(pubKeyZ32: string, options: PkarrRequestOptions = {}): DiscoveryBudgetError | null {
    if (!this.dht) return this.relays.publishHeld(pubKeyZ32, options);
    return this.dhtWriteWait(pubKeyZ32, options, true) > 0 ? this.relays.publishHeld(pubKeyZ32, options) : null;
  }
  onServerTime(listener: Parameters<RelayTransport["onServerTime"]>[0]): () => void { return this.relays.onServerTime(listener); }
  /**
   * `dhtDirect: false` (Hide my IP from contacts): no packet is put on or read from the DHT, and its node is closed, so
   * no UDP goes from this machine to a DHT node; true again starts it at the next put or read. Absent leaves it as it is.
   */
  configure({ relays, dhtDirect }: { relays: string[]; readRelays: boolean; dhtDirect?: boolean }): void {
    if (!this.pinned) this.relays.setRelays(relays);
    if (dhtDirect === undefined) return;
    this.direct = dhtDirect;
    if (!dhtDirect) this.mainline?.stop().catch(() => {});
  }
  /**
   * The relays' side, and a write's turn `publishHeld` gave that no publish took (`writeTurns`). What the DHT side keeps
   * per key otherwise is bounded (`missing`, `MISSING_KEPT`; the background budgets' windows).
   */
  forget(keys: Iterable<string>): void {
    const gone = [...keys];
    for (const key of gone) this.writeTurns.delete(key);
    this.relays.forget(gone);
  }
}
