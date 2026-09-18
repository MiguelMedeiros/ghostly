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
        const response = await this.request(`${relay}/${identity.pubKeyZ32}`, {
          method: "PUT",
          body: payload as BodyInit,
        });
        if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
      }),
    );

    if (!results.some((r) => r.status === "fulfilled")) {
      const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).join("; ");
      throw new Error(`Publish failed on every relay: ${reasons}`);
    }
  }

  /** Asks every relay and keeps the newest packet that carries a valid signature. */
  async resolve(pubKeyZ32: string): Promise<SignedPacket | null> {
    if (this.relays.length === 0) throw new Error("No Pkarr relays configured");

    const results = await Promise.allSettled(
      this.relays.map(async (relay) => {
        const response = await this.request(`${relay}/${pubKeyZ32}`, { method: "GET" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`${relay} responded ${response.status}`);
        return parseRelayPayload(pubKeyZ32, new Uint8Array(await response.arrayBuffer()));
      }),
    );

    let newest: SignedPacket | null = null;
    let reachable = false;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      reachable = true;
      const packet = result.value;
      if (packet && (!newest || packet.timestampMicros > newest.timestampMicros)) newest = packet;
    }
    if (!reachable) throw new Error("No Pkarr relay reachable");
    return newest;
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
