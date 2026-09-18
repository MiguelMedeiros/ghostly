import type { Identity } from "./identity";
import { createRelayPayload, parseRelayPayload, type GhostRecord, type SignedPacket } from "./pkarr";
import type { PkarrTransport } from "./transport";

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
const REQUESTS_PER_MINUTE = 30;
/** A relay that fails at the network level is left alone for this long. */
const NETWORK_ERROR_COOLDOWN_MS = 20_000;

export interface RelayTransportOptions {
  relays?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
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
  private cursor = 0;
  private readonly spent = new Map<string, number[]>();
  /** Timestamp of the last packet sent to each relay, per key: the compare-and-swap value for the next one. */
  private readonly lastPut = new Map<string, bigint>();

  constructor(options: RelayTransportOptions = {}) {
    this.relays = [];
    this.setRelays(options.relays ?? DEFAULT_RELAYS);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
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
  async publish(identity: Identity, records: GhostRecord[]): Promise<void> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");

    // BEP44 sequence numbers must strictly increase.
    const now = BigInt(Date.now()) * 1000n;
    const last = this.lastTimestamp.get(identity.pubKeyZ32) ?? 0n;
    const timestamp = now > last ? now : last + 1n;
    this.lastTimestamp.set(identity.pubKeyZ32, timestamp);

    const payload = createRelayPayload(identity, records, timestamp);
    const results = await Promise.allSettled(
      this.relays.map(async (relay) => {
        const slot = `${relay} ${identity.pubKeyZ32}`;
        const previous = this.lastPut.get(slot);
        this.lastPut.set(slot, timestamp);

        // A relay refuses (428) to replace a packet whose DHT put is still in flight, unless told which
        // packet is being replaced. Links publish in bursts (a message, its ack, a signal), so say so.
        let response = await this.put(relay, identity.pubKeyZ32, payload, previous);
        // 412: the relay never got `previous` (it was busy, or restarted). There is one writer per key, so insist.
        if (response.status === 412) response = await this.put(relay, identity.pubKeyZ32, payload);
        if (response.status === 429) this.coolDown(relay, response);
        if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
      }),
    );

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
  async resolve(pubKeyZ32: string): Promise<SignedPacket | null> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");

    const start = this.cursor++;
    let reachable = false;
    for (let i = 0; i < this.relays.length; i++) {
      const relay = this.relays[(start + i) % this.relays.length];
      if ((this.coolingDown.get(relay) ?? 0) > Date.now() || !this.take(relay)) continue;
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
        // surfaces as a network error, so this is treated like a 429: try the next relay.
        this.coolingDown.set(relay, Date.now() + NETWORK_ERROR_COOLDOWN_MS);
      }
    }
    if (!reachable) {
      const resting = this.relays.every((r) => (this.coolingDown.get(r) ?? 0) > Date.now() || (this.spent.get(r)?.length ?? 0) >= REQUESTS_PER_MINUTE);
      // Holding back is not an outage: report what is already known.
      if (resting && this.newest.has(pubKeyZ32)) return this.newest.get(pubKeyZ32)!;
      throw new Error("No Pkarr relay reachable");
    }
    return this.newest.get(pubKeyZ32) ?? null;
  }

  private put(relay: string, pubKeyZ32: string, payload: Uint8Array, replaces?: bigint): Promise<Response> {
    return this.request(`${relay}/${pubKeyZ32}`, {
      method: "PUT",
      body: payload as BodyInit,
      headers: replaces === undefined ? undefined : { "If-Match": replaces.toString() },
    });
  }

  /** Polls wait their turn; publishes are rare and always go out. */
  private take(relay: string): boolean {
    const now = Date.now();
    const recent = (this.spent.get(relay) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= REQUESTS_PER_MINUTE) {
      this.spent.set(relay, recent);
      return false;
    }
    recent.push(now);
    this.spent.set(relay, recent);
    return true;
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
