import type { Identity } from "./identity";
import { createRelayPayload, openRelayPayload, parseRelayPayload, type GhostRecord, type SignedPacket } from "./pkarr";
import { RelayBreaker, type DiscoveryStatus, type RelayBreakerOptions, type RelayFailure } from "./relayBreaker";
import { DiscoveryBudgetError, isDiscoveryBudgetError, type PkarrRequestOptions, type PkarrTransport } from "./transport";

/**
 * Public Pkarr relays. They are generic Pkarr infrastructure (an HTTP bridge to
 * the Mainline DHT), not a Ghostly backend: they only ever see signed,
 * encrypted packets. Every client uses this list: the browser clients read and
 * write through it, Ghostly Desktop writes to it (so browser contacts see its
 * packets) and reads from it only when "Also use Pkarr relays" is on. Adding a
 * relay is one line here; see docs/RELAYS.md for how one is chosen.
 */
export const DEFAULT_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app", "https://relay.pkarr.org"];
/** Relay lists that were the defaults once: a profile that still has one gets today's defaults. */
export const PREVIOUS_DEFAULT_RELAYS = [["https://pkarr.pubky.org", "https://pkarr.pubky.app"]];

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
/** A relay that fails at the network level is left alone for this long. */
const NETWORK_ERROR_COOLDOWN_MS = 20_000;
/**
 * Relays that allow far fewer requests per address than the others: this client's share of theirs, a minute.
 * relay.pkarr.org allows 10 (`x-ratelimit-limit`), which a browser cannot read without CORS exposing it.
 */
export const RELAY_REQUESTS_PER_MINUTE: Record<string, number> = { "https://relay.pkarr.org": 5 };

export interface RelayTransportOptions {
  relays?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Requests allowed per relay and minute (`REQUESTS_PER_MINUTE`); background ones get a share of it.
   * `Infinity` for relays of one's own, with no limit to stay under (a test's relay in the same process).
   */
  requestsPerMinute?: number;
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
  private readonly coolingDown = new Map<string, number>();
  private readonly networkCooldown = new Map<string, number>();
  private cursor = 0;
  private readonly spent = new Map<string, number[]>();
  private readonly spentBackground = new Map<string, number[]>();
  /** When a link's write was last refused on each relay, while it waits for the budget. */
  private readonly writeWaiting = new Map<string, number>();
  /** Timestamp of the last packet sent to each relay, per key: the compare-and-swap value for the next one. */
  private readonly lastPut = new Map<string, bigint>();
  private readonly perMinute: number;
  private readonly backgroundPerMinute: number;
  private readonly breaker: RelayBreaker;
  /** The relay the last read was answered by. */
  private lastRelay: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options: RelayTransportOptions = {}) {
    this.relays = [];
    this.setRelays(options.relays ?? DEFAULT_RELAYS);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.perMinute = options.requestsPerMinute ?? REQUESTS_PER_MINUTE;
    this.backgroundPerMinute = this.perMinute === REQUESTS_PER_MINUTE ? BACKGROUND_REQUESTS_PER_MINUTE : Math.ceil(this.perMinute * 2 / 3);
    const log = options.log ?? ((line: string) => console.info(`[ghostly:relay] ${line}`));
    this.breaker = new RelayBreaker({
      ...options.breaker,
      onTrip: (relay, reason, forMs) => {
        log(`${new URL(relay).host} tripped (${reason}); left alone for ${Math.round(forMs / 1000)} s`);
        options.breaker?.onTrip?.(relay, reason, forMs);
        this.changed();
      },
      onRecover: (relay) => {
        log(`${new URL(relay).host} answered again`);
        options.breaker?.onRecover?.(relay);
        this.changed();
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

  /** Called when a relay trips or recovers. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) try { listener(); } catch { /* a listener that fails must not fail a request */ }
  }

  /** What the relay did, for its breaker. */
  private answered(relay: string, failure?: { kind: RelayFailure; reason: string }): void {
    if (failure) this.breaker.failure(relay, failure.kind, failure.reason);
    else this.breaker.success(relay);
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
    const waitingBefore = new Map(this.writeWaiting);
    // Out on one relay: the link will not try again, so a relay that refused it has no write to wait for.
    const noWriteWaits = () => {
      for (const relay of this.relays) if (this.writeWaiting.get(relay) !== waitingBefore.get(relay)) this.writeWaiting.delete(relay);
    };
    const puts = this.relays.map(async (relay) => {
      const slot = `${relay} ${pubKeyZ32}`;
      const previous = this.lastPut.get(slot);
      this.lastPut.set(slot, timestamp);

      // A relay refuses (428) to replace a packet whose DHT put is still in flight, unless told which
      // packet is being replaced. Links publish in bursts (a message, its ack, a signal), so say so.
      let response = await this.put(relay, pubKeyZ32, payload, previous, options.background);
      // 412: the relay never got `previous` (it was busy, or restarted). There is one writer per key, so insist.
      if (response.status === 412) response = await this.put(relay, pubKeyZ32, payload, undefined, options.background);
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

    const start = this.cursor++;
    let reachable = false;
    // The soonest a relay passed over for its budget takes a request again, and whether one was down instead.
    let budgetWait = Infinity, down = false;
    for (let i = 0; i < this.relays.length; i++) {
      const relay = this.relays[(start + i) % this.relays.length];
      if (this.networkCoolingDown(relay, "GET")) { down = true; continue; }
      const limited = this.rateLimitedFor(relay);
      if (limited > 0) { budgetWait = Math.min(budgetWait, limited); continue; }
      // Its breaker is open: a relay throttling us is a wait, one failing is down. The others take its turn.
      const blocked = this.breaker.blockedFor(relay);
      if (blocked > 0) {
        if (this.breaker.blockedKind(relay) === "throttled") budgetWait = Math.min(budgetWait, blocked); else down = true;
        continue;
      }
      if (!this.take(relay, options.background, false)) { budgetWait = Math.min(budgetWait, this.freeInMs(relay, options.background, false)); continue; }
      this.breaker.begin(relay);
      let status = 0;
      try {
        const response = await this.request(`${relay}/${pubKeyZ32}`, { method: "GET" });
        status = response.status;
        if (response.status === 429) {
          budgetWait = Math.min(budgetWait, this.coolDown(relay, response));
          this.answered(relay, { kind: "throttled", reason: "rate limited (429)" });
          continue;
        }
        if (response.status !== 404) {
          if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
          const packet = parseRelayPayload(pubKeyZ32, new Uint8Array(await response.arrayBuffer()));
          const known = this.newest.get(pubKeyZ32);
          if (!known || packet.timestampMicros > known.timestampMicros) this.newest.set(pubKeyZ32, packet);
        }
        this.answered(relay);
        this.lastRelay = relay;
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
      const resting = this.relays.every((r) => this.isCoolingDown(r, "GET") || this.breaker.blockedFor(r) > 0 || (this.spent.get(r)?.length ?? 0) >= this.limitOf(r) || this.writeFirst(r)
        || (!!options.background && (this.spentBackground.get(r)?.length ?? 0) >= this.backgroundPerMinute));
      // Holding back is not an outage: report what is already known…
      if (resting && this.newest.has(pubKeyZ32)) return this.newest.get(pubKeyZ32)!;
      // …or, knowing nothing yet, that the read waits for the budget.
      if (!down && budgetWait < Infinity) throw new DiscoveryBudgetError(budgetWait);
      throw new Error("No Pkarr relay reachable");
    }
    return this.newest.get(pubKeyZ32) ?? null;
  }

  private async put(relay: string, pubKeyZ32: string, payload: Uint8Array, replaces?: bigint, background = false): Promise<Response> {
    if (this.networkCoolingDown(relay, "PUT")) throw new Error("Discovery relay is cooling down; retry shortly");
    const limited = this.rateLimitedFor(relay);
    if (limited > 0) throw new DiscoveryBudgetError(limited, "Discovery relay is cooling down after a 429; retry shortly");
    const blocked = this.breaker.blockedFor(relay);
    if (blocked > 0) {
      if (this.breaker.blockedKind(relay) === "throttled") throw new DiscoveryBudgetError(blocked, "Discovery relay is throttling this address; retry shortly");
      throw new Error(`${relay} is left alone after failing; retry shortly`);
    }
    if (!this.take(relay, background, true)) throw new DiscoveryBudgetError(this.freeInMs(relay, background, true));
    this.breaker.begin(relay);
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
    else this.answered(relay);
    return response;
  }

  /**
   * Discovery reads and writes share a bounded per-relay request budget; background requests only part
   * of it. A link's write the budget refused goes before any read once a request is free again.
   */
  private take(relay: string, background: boolean | undefined, write: boolean): boolean {
    const now = Date.now();
    const recent = (this.spent.get(relay) ?? []).filter((at) => now - at < 60_000);
    const recentBackground = (this.spentBackground.get(relay) ?? []).filter((at) => now - at < 60_000);
    this.spent.set(relay, recent);
    this.spentBackground.set(relay, recentBackground);
    const linkWrite = write && !background;
    if (recent.length >= this.limitOf(relay) || (background && recentBackground.length >= this.backgroundPerMinute) || (!linkWrite && this.writeFirst(relay, now))) {
      if (linkWrite) this.writeWaiting.set(relay, now);
      return false;
    }
    if (linkWrite) this.writeWaiting.delete(relay);
    recent.push(now);
    if (background) recentBackground.push(now);
    return true;
  }

  /**
   * How long until this relay's budget takes the request `take` just refused: the oldest request of the minute over
   * the limit ages out, or a waiting link write has had its turn. `take` keeps the lists to the minute, oldest first.
   */
  private freeInMs(relay: string, background: boolean | undefined, write: boolean, now = Date.now()): number {
    const recent = this.spent.get(relay) ?? [], recentBackground = this.spentBackground.get(relay) ?? [];
    let wait = 0;
    const limit = this.limitOf(relay);
    if (recent.length >= limit) wait = Math.max(wait, recent[recent.length - limit] + 60_000 - now);
    if (background && recentBackground.length >= this.backgroundPerMinute)
      wait = Math.max(wait, recentBackground[recentBackground.length - this.backgroundPerMinute] + 60_000 - now);
    if (!(write && !background) && this.writeFirst(relay, now)) wait = Math.max(wait, this.writeWaiting.get(relay)! + WRITE_FIRST_MS - now);
    return Math.max(wait, 1);
  }

  /** Requests allowed to this relay a minute: this client's budget, or less for a relay known to allow few. */
  private limitOf(relay: string): number {
    return Math.min(this.perMinute, RELAY_REQUESTS_PER_MINUTE[relay] ?? Infinity);
  }

  /** A link's write is waiting for this relay's budget: reads (and background writes) let it go first. */
  private writeFirst(relay: string, now = Date.now()): boolean {
    return now - (this.writeWaiting.get(relay) ?? -Infinity) < WRITE_FIRST_MS;
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

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Relays answer with `cache-control: max-age=300`; polling needs fresh data.
      return await this.fetchFn(url, { ...init, cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
