import type { Identity } from "./identity";
import { createRelayPayload, parseRelayPayload, type GhostRecord, type SignedPacket } from "./pkarr";
import type { PkarrRequestOptions, PkarrTransport } from "./transport";

/**
 * Public Pkarr relays. They are generic Pkarr infrastructure (an HTTP bridge to
 * the Mainline DHT), not a Ghostly backend: they only ever see signed,
 * encrypted packets. `pkarr.pubky.org` is also in the default relay set of the
 * Rust client used by Ghostly Desktop, so both clients share a fast path.
 */
export const DEFAULT_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];

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

export interface RelayTransportOptions {
  relays?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Requests allowed per relay and minute (`REQUESTS_PER_MINUTE`); background ones get a share of it.
   * `Infinity` for relays of one's own, with no limit to stay under (a test's relay in the same process).
   */
  requestsPerMinute?: number;
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

  constructor(options: RelayTransportOptions = {}) {
    this.relays = [];
    this.setRelays(options.relays ?? DEFAULT_RELAYS);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.perMinute = options.requestsPerMinute ?? REQUESTS_PER_MINUTE;
    this.backgroundPerMinute = this.perMinute === REQUESTS_PER_MINUTE ? BACKGROUND_REQUESTS_PER_MINUTE : Math.ceil(this.perMinute * 2 / 3);
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
   */
  async publish(identity: Identity, records: GhostRecord[], options: PkarrRequestOptions = {}): Promise<void> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");

    // BEP44 sequence numbers must strictly increase.
    const now = BigInt(Date.now()) * 1000n;
    const last = this.lastTimestamp.get(identity.pubKeyZ32) ?? 0n;
    const timestamp = now > last ? now : last + 1n;
    this.lastTimestamp.set(identity.pubKeyZ32, timestamp);

    const payload = createRelayPayload(identity, records, timestamp);
    const waitingBefore = new Map(this.writeWaiting);
    const results = await Promise.allSettled(
      this.relays.map(async (relay) => {
        const slot = `${relay} ${identity.pubKeyZ32}`;
        const previous = this.lastPut.get(slot);
        this.lastPut.set(slot, timestamp);

        // A relay refuses (428) to replace a packet whose DHT put is still in flight, unless told which
        // packet is being replaced. Links publish in bursts (a message, its ack, a signal), so say so.
        let response = await this.put(relay, identity.pubKeyZ32, payload, previous, options.background);
        // 412: the relay never got `previous` (it was busy, or restarted). There is one writer per key, so insist.
        if (response.status === 412) response = await this.put(relay, identity.pubKeyZ32, payload, undefined, options.background);
        if (response.status === 429) this.coolDown(relay, response);
        if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
      }),
    );

    // Out on one relay: the link will not try again, so a relay that refused it has no write to wait for.
    if (results.some((r) => r.status === "fulfilled")) {
      for (const relay of this.relays) if (this.writeWaiting.get(relay) !== waitingBefore.get(relay)) this.writeWaiting.delete(relay);
    }
    if (!results.some((r) => r.status === "fulfilled")) {
      const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join("; ");
      throw new Error(`Publish failed on every relay: ${reasons}`);
    }
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
    for (let i = 0; i < this.relays.length; i++) {
      const relay = this.relays[(start + i) % this.relays.length];
      if (this.isCoolingDown(relay, "GET") || !this.take(relay, options.background, false)) continue;
      try {
        const response = await this.request(`${relay}/${pubKeyZ32}`, { method: "GET" });
        if (response.status === 429) {
          this.coolDown(relay, response);
          continue;
        }
        if (response.status !== 404) {
          if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
          const packet = parseRelayPayload(pubKeyZ32, new Uint8Array(await response.arrayBuffer()));
          const known = this.newest.get(pubKeyZ32);
          if (!known || packet.timestampMicros > known.timestampMicros) this.newest.set(pubKeyZ32, packet);
        }
        reachable = true;
        break;
      } catch {
        // In a browser a rate-limited answer often arrives without CORS headers and
        // surfaces as a network error. Back off this operation and try the next relay.
        // Unlike an observable 429, this does not establish a relay-wide limit.
        this.networkCooldown.set(`GET ${relay}`, Date.now() + NETWORK_ERROR_COOLDOWN_MS);
      }
    }
    if (!reachable) {
      const resting = this.relays.every((r) => this.isCoolingDown(r, "GET") || (this.spent.get(r)?.length ?? 0) >= this.perMinute || this.writeFirst(r)
        || (!!options.background && (this.spentBackground.get(r)?.length ?? 0) >= this.backgroundPerMinute));
      // Holding back is not an outage: report what is already known.
      if (resting && this.newest.has(pubKeyZ32)) return this.newest.get(pubKeyZ32)!;
      throw new Error("No Pkarr relay reachable");
    }
    return this.newest.get(pubKeyZ32) ?? null;
  }

  private async put(relay: string, pubKeyZ32: string, payload: Uint8Array, replaces?: bigint, background = false): Promise<Response> {
    if (this.isCoolingDown(relay, "PUT")) throw new Error("Discovery relay is cooling down; retry shortly");
    if (!this.take(relay, background, true)) throw new Error("Discovery request budget reached; retry shortly");
    try { return await this.request(`${relay}/${pubKeyZ32}`, {
      method: "PUT",
      body: payload as BodyInit,
      headers: replaces === undefined ? undefined : { "If-Match": replaces.toString() },
    }); } catch (error) {
      this.networkCooldown.set(`PUT ${relay}`, Date.now() + NETWORK_ERROR_COOLDOWN_MS);
      throw error;
    }
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
    if (recent.length >= this.perMinute || (background && recentBackground.length >= this.backgroundPerMinute) || (!linkWrite && this.writeFirst(relay, now))) {
      if (linkWrite) this.writeWaiting.set(relay, now);
      return false;
    }
    if (linkWrite) this.writeWaiting.delete(relay);
    recent.push(now);
    if (background) recentBackground.push(now);
    return true;
  }

  /** A link's write is waiting for this relay's budget: reads (and background writes) let it go first. */
  private writeFirst(relay: string, now = Date.now()): boolean {
    return now - (this.writeWaiting.get(relay) ?? -Infinity) < WRITE_FIRST_MS;
  }

  private isCoolingDown(relay: string, method: "GET" | "PUT"): boolean {
    return Math.max(this.coolingDown.get(relay) ?? 0, this.networkCooldown.get(`${method} ${relay}`) ?? 0) > Date.now();
  }

  private coolDown(relay: string, response: Response): void {
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
    const seconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 120) : 15;
    this.coolingDown.set(relay, Date.now() + seconds * 1000);
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
