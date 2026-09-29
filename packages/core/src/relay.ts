import type { Identity } from "./identity";
import { createRelayPayload, newerPacket, openRelayPayload, parseRelayPayload, RELAY_PAYLOAD_MAX_BYTES, type GhostRecord, type SignedPacket } from "./pkarr";
import { RelayBreaker, type DiscoveryStatus, type RelayBreakerOptions, type RelayFailure } from "./relayBreaker";
import { DiscoveryBudgetError, isDiscoveryBudgetError, type DiscoveryChange, type PkarrRequestOptions, type PkarrTransport } from "./transport";

/** Who asks, for the budget: a 1:1 chat's link comes before a group's, and both before background looks. */
interface Asker { background: boolean; group: boolean; urgent: boolean; door: boolean; write: boolean }
const asker = (options: PkarrRequestOptions, write: boolean): Asker => ({ background: !!options.background, group: !!options.group, urgent: !!options.urgent, door: !!options.door, write });
/** A 1:1 chat's request: neither a group's nor a background one. */
const isChat = (who: Asker): boolean => !who.background && !who.group;
/** A group's edge looking fast for a signal (`GROUP_BURST_MS`). */
const isGroupUrgentRead = (who: Asker): boolean => who.group && who.urgent && !who.write && !who.background;
/** A write that goes first once the budget frees a request (see `WRITE_FIRST_MS`): a chat's or a group's, never a background one. */
const firstWriter = (who: Asker): "chat" | "group" | null => (!who.write || who.background ? null : who.group ? "group" : "chat");

/**
 * Public Pkarr relays. They are generic Pkarr infrastructure (an HTTP bridge to
 * the Mainline DHT), not a Ghostly backend: they only ever see signed,
 * encrypted packets. Every client uses this list: the browser clients read and
 * write through it, Ghostly Desktop writes to it (so browser contacts see its
 * packets) and reads from it only when "Also use Pkarr relays" is on. Adding a
 * relay is one line here; see docs/RELAYS.md for how one is chosen.
 */
export const DEFAULT_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];
/**
 * Relay lists that were the defaults once: a profile that still has one gets today's defaults. When a relay
 * joins `DEFAULT_RELAYS`, the list as it was goes here, so profiles on the old defaults move with it.
 */
export const PREVIOUS_DEFAULT_RELAYS: string[][] = [];

/** The defaults for `relays` when it is one of the old default lists, `relays` itself otherwise. */
export function currentRelays(relays: string[]): string[] {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((relay, i) => relay === b[i]);
  return PREVIOUS_DEFAULT_RELAYS.some((old) => same(old, relays)) ? [...DEFAULT_RELAYS] : relays;
}

/**
 * Requests this client allows itself per relay and minute. Relays limit by IP
 * (120 a minute when this was written) and one address is often shared by
 * several peers: two browser profiles, a tab and an extension, a household.
 */
export const REQUESTS_PER_MINUTE = 30;
/**
 * Of those, what background requests (`{ background: true }`: periodic looks at shared records, as a
 * community group's hub makes) may spend, counted on their own: the rest is kept for links, whose
 * signaling cannot wait, and a burst of signaling does not hold the background ones back afterwards.
 */
export const BACKGROUND_REQUESTS_PER_MINUTE = 20;
/**
 * A link's write the budget refused (its presence, its offer, its answer) goes first when the minute
 * frees a request: reads on that relay wait this long after the refusal. A link that polls fast for a
 * peer while its offer waits would otherwise take every request the minute frees, and the offer (the
 * only thing that peer is waiting for) would go out only once the polling slowed down, half a minute later.
 */
export const WRITE_FIRST_MS = 5_000;
/**
 * Once a 1:1 chat needs the relays (the budget refused one of its requests there, or it read urgently anywhere: it polls
 * fast for a signal due any moment), group requests leave it the last this many of each minute, for a minute. Groups
 * that spend the whole budget spend it over the minute, so the chat then takes the next request that frees, within
 * seconds, and has room for what follows (the receipt). Waiting for a refusal was too late when a contact went away
 * from a chat and from groups at once: the chat and the groups' edges all watched fast for it, the edges spent both
 * relays' minute in 40 s, and the chat read the contact's offer half a minute late (2026-09-27). A chat with nothing
 * to wait for leaves groups the whole budget: a community door alone costs about 22 requests a minute, and a reserve
 * kept for any chat starved a new group's edges.
 */
export const CHAT_RESERVE = 10;
/**
 * Groups' urgent reads (their edges looking fast for a signal) take at most a quarter of a relay's minute in any this
 * long, so that they never spend it in a burst. An app back after a restart has every edge offering and looking fast at
 * once; the members at the other end answer only once they notice its old sessions went (about 20 s with
 * node-datachannel). On the default relays the edges spent the groups' share of the minute in those seconds, and read
 * nothing for 40 s more: a private group's edges were live again 75 to 110 s after a restart (bug hunt r5a, 2026-09-29).
 */
export const GROUP_BURST_MS = 15_000;
/** …and never fewer than one link polling fast (every 2 s) reads in that time: one edge alone is never held back. */
export const GROUP_BURST_ONE_LINK = 8;
/**
 * While a link polls fast (an `urgent` read: its peer, or the peer's offer or answer, is due any moment) within this
 * long, background requests (a community's periodic looks) are held to `BACKGROUND_WHILE_SIGNALING` a minute on each
 * relay rather than their usual share. A fast poll reads every 2 s, one relay after the other.
 */
export const SIGNALING_WINDOW_MS = 10_000;
/**
 * Background requests a minute on each relay while a link signals: one look every 12 s. Next to a community's
 * lookups (20 a minute), a new group edge on one relay got 10 and read every 6 s, and its offer and answer missed each
 * other's fast windows (2026-09-27). Not none: fast windows can follow one another, and a hub still reads its knocks.
 */
export const BACKGROUND_WHILE_SIGNALING = 5;
/**
 * A read of a key the relays answered this recently is answered from that answer, with no request. Several parts of
 * a chat read the contact's keys (the link's poll, its capabilities, DHT delivery), and each tends to read again
 * within a few dozen milliseconds of its last read, when a pace changes or a signal goes out: nothing new can be there
 * yet, and a pairing spent a sixth of its requests on those reads (2026-09-27). A publish under the key forgets it.
 */
export const FRESH_READ_MS = 500;
/** A relay that fails at the network level is left alone for this long. */
const NETWORK_ERROR_COOLDOWN_MS = 20_000;
/**
 * Relays whose limit per address is far from the others': this client's share of theirs, a minute, in place of
 * `REQUESTS_PER_MINUTE`. relay.pkarr.org (not a default, see docs/RELAYS.md) allows 10 (`x-ratelimit-limit`), which a
 * browser cannot read without CORS exposing it. pkarr.pubky.app allows 1000 (pkarr.pubky.org, on the same address,
 * 50): 60 of ours leaves room for many peers behind one address, and a page that pairs three contacts in a minute,
 * about ten requests a relay each, still has requests to spare there (2026-09-28). Writes go to every relay and
 * count once one took them; reads go to a relay with requests left.
 */
export const RELAY_REQUESTS_PER_MINUTE: Record<string, number> = { "https://relay.pkarr.org": 5, "https://pkarr.pubky.app": 60 };

export interface RelayTransportOptions {
  relays?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Requests allowed per relay and minute (`REQUESTS_PER_MINUTE`); background ones get a share of it.
   * `Infinity` for relays of one's own, with no limit to stay under (a test's relay in the same process).
   */
  requestsPerMinute?: number;
  /** How long a read answers the next ones of the same key (`FRESH_READ_MS`); 0 makes every read a request. */
  freshReadMs?: number;
  /** The circuit breaker's settings (tests shorten its waits); trips are logged with `log`. */
  breaker?: RelayBreakerOptions;
  /** Where a relay that trips or recovers is reported; never with a key. `console.info` by default. */
  log?: (line: string) => void;
}

export function normalizeRelayUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export class RelayTransport implements PkarrTransport {
  private relays: string[];
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly lastTimestamp = new Map<string, bigint>();
  private readonly newest = new Map<string, SignedPacket>();
  /**
   * The last packet this client put under a key that a relay took. A read the budget holds back answers the newer of
   * it and the last one read: a hub that wrote its own beacon entry since it last read the beacon must not see that
   * entry as old as the one it replaced (it would stop counting itself at its community's door until its next write).
   */
  private readonly written = new Map<string, SignedPacket>();
  private readonly coolingDown = new Map<string, number>();
  private readonly networkCooldown = new Map<string, number>();
  private cursor = 0;
  private readonly spent = new Map<string, number[]>();
  private readonly spentBackground = new Map<string, number[]>();
  /** Groups' urgent reads on each relay in the last `GROUP_BURST_MS`. */
  private readonly spentGroupUrgent = new Map<string, number[]>();
  /** When a link's write was last refused on each relay (`chat <relay>`, `group <relay>`), while it waits for the budget. */
  private readonly writeWaiting = new Map<string, number>();
  /** When the budget last refused a 1:1 chat's request on each relay: for the next minute, groups leave it `CHAT_RESERVE`. */
  private readonly chatRefused = new Map<string, number>();
  /** When a 1:1 chat last read urgently (on any relay): for the next minute, groups leave it `CHAT_RESERVE` on every relay. */
  private chatUrgentAt = -Infinity;
  /** When a link (a chat's or a group's) last asked urgently: background requests yield for `SIGNALING_WINDOW_MS`. */
  private urgentAt = -Infinity;
  /** Timestamp of the last packet sent to each relay, per key: the compare-and-swap value for the next one. */
  private readonly lastPut = new Map<string, bigint>();
  /** When the relays last answered a read of each key, for `FRESH_READ_MS`. */
  private readonly readAt = new Map<string, number>();
  private readonly freshReadMs: number;
  private readonly perMinute: number;
  /** `requestsPerMinute` was given: it bounds every relay, one with its own share (`RELAY_REQUESTS_PER_MINUTE`) too. */
  private readonly perMinuteGiven: boolean;
  private readonly backgroundPerMinute: number;
  private readonly backgroundWhileSignaling: number;
  private readonly breaker: RelayBreaker;
  /** The relay the last read was answered by. */
  private lastRelay: string | null = null;
  private readonly listeners = new Set<(change?: DiscoveryChange) => void>();

  constructor(options: RelayTransportOptions = {}) {
    this.relays = [];
    this.setRelays(options.relays ?? DEFAULT_RELAYS);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.perMinute = options.requestsPerMinute ?? REQUESTS_PER_MINUTE;
    this.freshReadMs = options.freshReadMs ?? FRESH_READ_MS;
    this.perMinuteGiven = options.requestsPerMinute !== undefined;
    this.backgroundPerMinute = this.perMinute === REQUESTS_PER_MINUTE ? BACKGROUND_REQUESTS_PER_MINUTE : Math.ceil(this.perMinute * 2 / 3);
    this.backgroundWhileSignaling = this.perMinute === REQUESTS_PER_MINUTE ? BACKGROUND_WHILE_SIGNALING : Math.ceil(this.perMinute / 6);
    const log = options.log ?? ((line: string) => console.info(`[ghostly:relay] ${line}`));
    this.breaker = new RelayBreaker({
      ...options.breaker,
      onTrip: (relay, reason, forMs) => {
        log(`${new URL(relay).host} tripped (${reason}); left alone for ${Math.round(forMs / 1000)} s`);
        options.breaker?.onTrip?.(relay, reason, forMs);
        this.changed("tripped");
      },
      onRecover: (relay) => {
        log(`${new URL(relay).host} answered again`);
        options.breaker?.onRecover?.(relay);
        this.changed("recovered");
      },
    });
  }

  /** How reads go and how each relay is doing, for the connection panel. */
  discovery(): DiscoveryStatus {
    const relays = this.breaker.health(this.relays).map((health) => {
      const limited = this.rateLimitedFor(health.relay);
      return health.state === "ok" && limited > 0 ? { ...health, state: "throttled" as const, until: Date.now() + limited, reason: "rate limited (429)" } : health;
    });
    return { path: this.lastRelay ? { via: "relay", relay: this.lastRelay } : null, relays };
  }

  /** Back online on some network: relays that failed (or rate limited this address) on the old one are asked again. */
  networkChanged(): void {
    this.breaker.reset();
    this.networkCooldown.clear();
    this.coolingDown.clear();
    this.changed("recovered");
  }

  /** Called when a relay trips or recovers. */
  subscribe(listener: (change?: DiscoveryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: DiscoveryChange): void {
    for (const listener of this.listeners) try { listener(change); } catch { /* a listener that fails must not fail a request */ }
  }

  /** What the relay did, for its breaker. */
  private answered(relay: string, failure?: { kind: RelayFailure; reason: string }, method?: "GET" | "PUT"): void {
    if (failure) { this.breaker.failure(relay, failure.kind, failure.reason); return; }
    // It answered this kind of request: an earlier failure of it no longer keeps the next one back.
    if (method) this.networkCooldown.delete(`${method} ${relay}`);
    this.breaker.success(relay);
  }

  setRelays(relays: string[]): void {
    const normalized = relays
      .map(normalizeRelayUrl)
      .filter((r): r is string => r !== null);
    this.relays = [...new Set(normalized)];
  }

  describe(): { protocol: string; relays: string[] } {
    return { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: [...this.relays] };
  }

  /**
   * Publishes to every relay. Peers may be configured with different relay
   * sets; writing everywhere keeps the overlap warm, the DHT covers the rest.
   * Returns once one relay took the packet: the others finish in the background.
   */
  async publish(identity: Identity, records: GhostRecord[], options: PkarrRequestOptions = {}): Promise<void> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");

    // BEP44 sequence numbers must strictly increase.
    const now = BigInt(Date.now()) * 1000n;
    const last = this.lastTimestamp.get(identity.pubKeyZ32) ?? 0n;
    const timestamp = now > last ? now : last + 1n;
    this.lastTimestamp.set(identity.pubKeyZ32, timestamp);

    await this.putEverywhere(identity.pubKeyZ32, createRelayPayload(identity, records, timestamp), timestamp, options);
  }

  /** Puts a payload signed elsewhere (a did:dht document), byte for byte, on every relay. */
  async publishPayload(pubKeyZ32: string, payload: Uint8Array, options: PkarrRequestOptions = {}): Promise<void> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");
    const { seq } = openRelayPayload(pubKeyZ32, payload);
    await this.putEverywhere(pubKeyZ32, payload, seq, options);
  }

  /**
   * Puts the packet on every relay and settles as soon as one of them took it. A relay that is slow to
   * answer (one that stores the packet and answers the PUT only at the timeout) must not hold a link's
   * presence, offer or answer back: the rest finish in the background, their outcomes still counted.
   * When no relay takes it, this waits for all of them to say why.
   */
  private putEverywhere(pubKeyZ32: string, payload: Uint8Array, timestamp: bigint, options: PkarrRequestOptions): Promise<void> {
    // A record read, changed and written back (a lobby, a knock record) is read from the relays the next time.
    this.readAt.delete(pubKeyZ32);
    const waitingBefore = new Map(this.writeWaiting);
    const writer = firstWriter(asker(options, true));
    // Out on one relay: the link will not try again, so a relay that refused it has no write to wait for.
    const noWriteWaits = () => {
      if (!writer) return;
      for (const relay of this.relays) {
        const key = `${writer} ${relay}`;
        if (this.writeWaiting.get(key) !== waitingBefore.get(key)) this.writeWaiting.delete(key);
      }
    };
    // Every relay left alone for failing: one of them is asked anyway, now and then (`allDownProbe`).
    const probe = this.breaker.allDownProbe(this.relays);
    const puts = this.relays.map(async (relay) => {
      const slot = `${relay} ${pubKeyZ32}`;
      const previous = this.lastPut.get(slot);
      this.lastPut.set(slot, timestamp);

      // A relay refuses (428) to replace a packet whose DHT put is still in flight, unless told which
      // packet is being replaced. Links publish in bursts (a message, its ack, a signal), so say so.
      let response = await this.put(relay, pubKeyZ32, payload, previous, asker(options, true), relay === probe);
      // 412: the relay never got `previous` (it was busy, or restarted). There is one writer per key, so insist.
      if (response.status === 412) response = await this.put(relay, pubKeyZ32, payload, undefined, asker(options, true));
      // The relay's own rate limit: this packet did not go in, and goes once the relay says so.
      if (response.status === 429) throw new DiscoveryBudgetError(this.coolDown(relay, response), `${relay} responded 429; retry shortly`);
      if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
    });
    const settled = Promise.allSettled(puts);

    return new Promise<void>((resolve, reject) => {
      let accepted = false;
      for (const put of puts) {
        put.then(() => {
          if (accepted) return;
          accepted = true;
          noWriteWaits();
          try { this.written.set(pubKeyZ32, parseRelayPayload(pubKeyZ32, payload)); } catch { /* not a packet a read would take either */ }
          resolve();
        }, () => { /* read from `settled` */ });
      }
      void settled.then((results) => {
        // A relay that finished after the first one took the packet may have been refused on its retry since.
        if (accepted) { noWriteWaits(); return; }
        // Every relay held it back for its budget (this client's, or the relay's rate limit): a wait for the first
        // of them to free a request, not a failure.
        const held = results.map((r) => (r.status === "rejected" && isDiscoveryBudgetError(r.reason) ? r.reason : null));
        const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join("; ");
        if (held.every((e) => e !== null)) reject(new DiscoveryBudgetError(Math.min(...held.map((e) => e!.retryInMs)), `Publish held back on every relay: ${reasons}`));
        else reject(new Error(`Publish failed on every relay: ${reasons}`));
      });
    });
  }

  /**
   * Public relays rate limit by IP (120 requests a minute at the time of
   * writing) and several peers may share one address, so a poll costs one
   * request: relays are asked in turn, the next one only if this one fails.
   * The newest validly signed packet seen so far wins, which also covers a
   * relay that is still serving an older cached copy.
   */
  async resolve(pubKeyZ32: string, options: PkarrRequestOptions = {}): Promise<SignedPacket | null> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");
    const readAt = this.readAt.get(pubKeyZ32);
    if (readAt !== undefined && Date.now() - readAt < this.freshReadMs) return this.newest.get(pubKeyZ32) ?? null;

    const start = this.cursor++;
    let reachable = false;
    // Every relay left alone for failing: one of them is asked anyway, now and then (`allDownProbe`).
    const probe = this.breaker.allDownProbe(this.relays);
    // The soonest a relay passed over for its budget takes a request again, and whether one was down instead.
    let budgetWait = Infinity, down = false;
    const who = asker(options, false);
    for (let i = 0; i < this.relays.length; i++) {
      const relay = this.relays[(start + i) % this.relays.length];
      if (relay !== probe && this.networkCoolingDown(relay, "GET")) { down = true; continue; }
      const limited = this.rateLimitedFor(relay);
      if (limited > 0) { budgetWait = Math.min(budgetWait, limited); continue; }
      // Its breaker is open: a relay throttling us is a wait, one failing is down. The others take its turn.
      const blocked = relay === probe ? 0 : this.breaker.blockedFor(relay);
      if (blocked > 0) {
        if (this.breaker.blockedKind(relay) === "throttled") budgetWait = Math.min(budgetWait, blocked); else down = true;
        continue;
      }
      if (!this.take(relay, who)) { budgetWait = Math.min(budgetWait, this.heldFor(relay, who)); continue; }
      if (relay === probe) this.breaker.beginAllDown(relay); else this.breaker.begin(relay);
      let status = 0;
      try {
        let payload: Uint8Array | undefined;
        const response = await this.request(`${relay}/${pubKeyZ32}`, { method: "GET" }, async (r, signal) => {
          status = r.status;
          if (r.ok && r.status !== 404) payload = await readRelayBody(r, signal);
        });
        status = response.status;
        if (response.status === 429) {
          budgetWait = Math.min(budgetWait, this.coolDown(relay, response));
          this.answered(relay, { kind: "throttled", reason: "rate limited (429)" });
          continue;
        }
        if (response.status !== 404) {
          if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
          const packet = parseRelayPayload(pubKeyZ32, payload!);
          this.newest.set(pubKeyZ32, newerPacket(this.newest.get(pubKeyZ32), packet)!);
        }
        this.answered(relay, undefined, "GET");
        this.lastRelay = relay;
        this.answeredRead(pubKeyZ32);
        reachable = true;
        break;
      } catch {
        // In a browser a rate-limited answer often arrives without CORS headers and
        // surfaces as a network error. Back off this operation and try the next relay.
        // Unlike an observable 429, this does not establish a relay-wide limit.
        this.networkCooldown.set(`GET ${relay}`, Date.now() + NETWORK_ERROR_COOLDOWN_MS);
        this.answered(relay, { kind: "error", reason: status >= 200 && status < 300 ? "invalid packet" : status ? `HTTP ${status}` : "no answer" });
        down = true;
      }
    }
    if (!reachable) {
      const resting = this.relays.every((r) => this.isCoolingDown(r, "GET") || this.breaker.blockedFor(r) > 0 || this.heldFor(r, who) > 0);
      // Holding back is not an outage: report what is already known, this client's own writes included while only the
      // budget held the read (a relay that failed it says nothing of them: an inviter's placeholder under its contact's
      // key would hide the outage)…
      const known = down ? this.newest.get(pubKeyZ32) : newerPacket(this.newest.get(pubKeyZ32), this.written.get(pubKeyZ32));
      if (resting && known) return known;
      // …or, knowing nothing yet, that the read waits for the budget.
      if (!down && budgetWait < Infinity) throw new DiscoveryBudgetError(budgetWait);
      throw new Error("No Pkarr relay reachable");
    }
    return this.newest.get(pubKeyZ32) ?? null;
  }

  /** The relays answered a read of this key now; answers older than `FRESH_READ_MS` are dropped as the list grows. */
  private answeredRead(pubKeyZ32: string): void {
    const now = Date.now();
    this.readAt.delete(pubKeyZ32);
    this.readAt.set(pubKeyZ32, now);
    // Oldest first: drop the stale ones from the front.
    if (this.readAt.size > 64) for (const [key, at] of this.readAt) { if (now - at < this.freshReadMs) break; this.readAt.delete(key); }
  }

  private async put(relay: string, pubKeyZ32: string, payload: Uint8Array, replaces: bigint | undefined, who: Asker, probe = false): Promise<Response> {
    if (!probe && this.networkCoolingDown(relay, "PUT")) throw new Error("Discovery relay is cooling down; retry shortly");
    const limited = this.rateLimitedFor(relay);
    if (limited > 0) throw new DiscoveryBudgetError(limited, "Discovery relay is cooling down after a 429; retry shortly");
    const blocked = probe ? 0 : this.breaker.blockedFor(relay);
    if (blocked > 0) {
      if (this.breaker.blockedKind(relay) === "throttled") throw new DiscoveryBudgetError(blocked, "Discovery relay is throttling this address; retry shortly");
      throw new Error(`${relay} is left alone after failing; asked again in ${Math.max(1, Math.ceil(this.breaker.askedAgainIn(relay, this.relays) / 1000))} s`);
    }
    if (!this.take(relay, who)) throw new DiscoveryBudgetError(this.heldFor(relay, who));
    if (probe) this.breaker.beginAllDown(relay); else this.breaker.begin(relay);
    let response: Response;
    try { response = await this.request(`${relay}/${pubKeyZ32}`, {
      method: "PUT",
      body: payload as BodyInit,
      headers: replaces === undefined ? undefined : { "If-Match": replaces.toString() },
    }); } catch (error) {
      this.networkCooldown.set(`PUT ${relay}`, Date.now() + NETWORK_ERROR_COOLDOWN_MS);
      this.answered(relay, { kind: "error", reason: "no answer" });
      throw error;
    }
    // 409, 412 and 428 are the relay working as it should; its rate limit and its own errors count against it.
    if (response.status === 429) this.answered(relay, { kind: "throttled", reason: "rate limited (429)" });
    else if (response.status >= 500) this.answered(relay, { kind: "error", reason: `HTTP ${response.status}` });
    else this.answered(relay, undefined, "PUT");
    return response;
  }

  /**
   * Discovery reads and writes share a bounded per-relay request budget; background requests only part of it, and
   * groups leave a chat the budget refused its reserve. A link's write the budget refused goes before any read
   * once a request is free again.
   */
  private take(relay: string, who: Asker): boolean {
    const now = Date.now();
    const writer = firstWriter(who);
    // Asked, whether or not it gets a request now: the link is signaling, and a chat's needs its reserve from now on.
    if (who.urgent && !who.background) {
      this.urgentAt = now;
      if (isChat(who)) this.chatUrgentAt = now;
    }
    if (this.heldFor(relay, who, now) > 0) {
      if (isChat(who)) this.chatRefused.set(relay, now);
      if (writer) this.writeWaiting.set(`${writer} ${relay}`, now);
      return false;
    }
    if (writer) this.writeWaiting.delete(`${writer} ${relay}`);
    this.spent.get(relay)!.push(now);
    if (who.background) this.spentBackground.get(relay)!.push(now);
    if (isGroupUrgentRead(who)) this.spentGroupUrgent.get(relay)!.push(now);
    return true;
  }

  /**
   * How long until this relay's budget takes this request, 0 when it would now: the oldest request of the minute over
   * a limit ages out, a chat's reserve lapses, or a waiting write has had its turn. Keeps the lists to the minute, oldest first.
   *
   * Who goes first: a chat's refused write holds back everything but chat writes; a group's refused write holds back
   * group reads and background requests, never a chat's. Background requests yield to a link that signals.
   */
  private heldFor(relay: string, who: Asker, now = Date.now()): number {
    const recent = (this.spent.get(relay) ?? []).filter((at) => now - at < 60_000);
    const recentBackground = (this.spentBackground.get(relay) ?? []).filter((at) => now - at < 60_000);
    this.spent.set(relay, recent);
    this.spentBackground.set(relay, recentBackground);
    // Until the `limit`-th newest request of the minute ages out; 0 while fewer than `limit` were made.
    const over = (list: number[], limit: number) => (list.length >= limit ? list[list.length - limit] + 60_000 - now : 0);
    const limit = this.limitOf(relay);
    let wait = over(recent, limit);
    if (who.background) {
      wait = Math.max(wait, over(recentBackground, this.backgroundPerMinute));
      // A link signaling: background takes a smaller share until it stops, or until enough of its own age out. A
      // community door's bell does not: the links it signals for are often the ones its last admission opened.
      const signaling = this.urgentAt + SIGNALING_WINDOW_MS - now;
      if (signaling > 0 && !who.door) wait = Math.max(wait, Math.min(signaling, over(recentBackground, this.backgroundWhileSignaling)));
    }
    // Groups' urgent reads: their share of the minute spread over it (`GROUP_BURST_MS`).
    const burst = (this.spentGroupUrgent.get(relay) ?? []).filter((at) => now - at < GROUP_BURST_MS);
    this.spentGroupUrgent.set(relay, burst);
    if (isGroupUrgentRead(who)) {
      const most = Math.max(GROUP_BURST_ONE_LINK, Math.floor(limit * GROUP_BURST_MS / 60_000));
      if (burst.length >= most) wait = Math.max(wait, burst[burst.length - most] + GROUP_BURST_MS - now);
    }
    if (who.group) {
      const reserved = Math.max(this.chatRefused.get(relay) ?? -Infinity, this.chatUrgentAt) + 60_000 - now;
      if (reserved > 0) wait = Math.max(wait, Math.min(reserved, over(recent, limit - this.reserveOf(relay))));
    }
    const writer = firstWriter(who);
    const waiting = (lane: "chat" | "group") => {
      const at = this.writeWaiting.get(`${lane} ${relay}`);
      return at !== undefined && now - at < WRITE_FIRST_MS ? at + WRITE_FIRST_MS - now : 0;
    };
    if (writer !== "chat") wait = Math.max(wait, waiting("chat"));
    if ((writer === null && who.group) || who.background) wait = Math.max(wait, waiting("group"));
    return Math.max(wait, 0);
  }

  /** Requests allowed to this relay a minute: this client's budget, or the relay's own share (`RELAY_REQUESTS_PER_MINUTE`). */
  private limitOf(relay: string): number {
    const share = RELAY_REQUESTS_PER_MINUTE[relay];
    if (share === undefined) return this.perMinute;
    return this.perMinuteGiven ? Math.min(this.perMinute, share) : share;
  }

  /** What groups leave a chat on this relay: `CHAT_RESERVE`, or a third of a smaller budget. */
  private reserveOf(relay: string): number {
    return Math.min(CHAT_RESERVE, Math.floor(this.limitOf(relay) / 3));
  }

  private isCoolingDown(relay: string, method: "GET" | "PUT"): boolean {
    return this.rateLimitedFor(relay) > 0 || this.networkCoolingDown(relay, method);
  }

  /** Left alone after failing at the network level. */
  private networkCoolingDown(relay: string, method: "GET" | "PUT"): boolean {
    return (this.networkCooldown.get(`${method} ${relay}`) ?? 0) > Date.now();
  }

  /** How much longer the relay asked (429) to be left alone; 0 when it did not. */
  private rateLimitedFor(relay: string): number {
    return Math.max(0, (this.coolingDown.get(relay) ?? 0) - Date.now());
  }

  /** Leaves the relay alone for as long as its 429 asks; returns that, in ms. */
  private coolDown(relay: string, response: Response): number {
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const seconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 120) : 15;
    this.coolingDown.set(relay, Date.now() + seconds * 1000);
    return seconds * 1000;
  }

  /**
   * One request under one time limit. `read` runs before the timer is cleared, so a body read there is bounded in
   * time as well: a relay that sends its headers and then trickles, or never ends, is given up on like one that
   * never answered.
   */
  private async request(url: string, init: RequestInit, read?: (response: Response, signal: AbortSignal) => Promise<void>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Relays answer with `cache-control: max-age=300`; polling needs fresh data.
      const response = await this.fetchFn(url, { ...init, cache: "no-store", signal: controller.signal });
      await read?.(response, controller.signal);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A relay's answer body, at most RELAY_PAYLOAD_MAX_BYTES: refused on a larger `content-length` before anything is
 * read, and otherwise streamed with a running count, so a relay (a default one or one the person added, working or
 * compromised) cannot fill memory with a huge or endless body. Stops when `signal` aborts.
 */
export async function readRelayBody(response: Response, signal: AbortSignal, max = RELAY_PAYLOAD_MAX_BYTES): Promise<Uint8Array> {
  const tooLarge = () => new Error(`Relay answer is larger than ${max} bytes`);
  if (Number(response.headers.get("content-length")) > max) { void response.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  // The fetch aborts its own stream; this also stops a body that is not tied to the request's signal.
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      if (signal.aborted) throw new Error("Relay answer timed out");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Relay answer timed out");
      if (done) break;
      length += value.byteLength;
      if (length > max) { stop(); throw tooLarge(); }
      chunks.push(value);
    }
    const body = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
    return body;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
