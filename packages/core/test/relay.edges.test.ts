import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createRelayPayload } from "../src/pkarr";
import { didDhtDocument, encodeDidDhtPacket, signDidDhtPacket } from "../src/didDht";
import { DEFAULT_RELAYS, RelayTransport, normalizeRelayUrl } from "../src/relay";
import { DiscoveryBudgetError, isDiscoveryBudgetError } from "../src/transport";

// covers: core.relay-client

const id = createIdentity();
const packet = (micros: bigint) => new Response(createRelayPayload(id, [{ label: "_ts", value: String(micros) }], micros) as BodyInit);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("relay URLs", () => {
  it("keeps http(s) origins and paths without trailing slashes, and refuses anything else", () => {
    expect(normalizeRelayUrl(" https://relay.test/pkarr/// ")).toBe("https://relay.test/pkarr");
    expect(normalizeRelayUrl("http://relay.test")).toBe("http://relay.test");
    expect(normalizeRelayUrl("https://relay.test/?q=1#x")).toBe("https://relay.test");
    for (const bad of ["ftp://relay.test", "javascript:alert(1)", "relay.test", "", "file:///etc/passwd"]) expect(normalizeRelayUrl(bad)).toBeNull();
  });

  it("defaults to the public relays, drops invalid and duplicate ones, and describes itself", () => {
    expect(new RelayTransport().describe().relays).toEqual(DEFAULT_RELAYS);
    const relay = new RelayTransport({ relays: ["https://a.test/", "https://a.test", "nope", "ftp://b.test"], fetch: vi.fn() });
    expect(relay.describe()).toEqual({ protocol: expect.stringContaining("Pkarr"), relays: ["https://a.test"] });
  });

  it("refuses to publish or resolve with no relays configured", async () => {
    const relay = new RelayTransport({ relays: [], fetch: vi.fn() });
    await expect(relay.publish(id, [])).rejects.toThrow("No Pkarr relays configured");
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow("No Pkarr relays configured");
  });

  it("uses the global fetch when none is given, and asks for fresh data", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const relay = new RelayTransport({ relays: ["https://a.test"] });
    expect(await relay.resolve(id.pubKeyZ32)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`https://a.test/${id.pubKeyZ32}`, expect.objectContaining({ method: "GET", cache: "no-store" }));
  });
});

describe("publishing", () => {
  it("puts a payload signed elsewhere byte for byte, its own sequence number as the next If-Match, and refuses a forged one", async () => {
    const seen: { url: string; body: Uint8Array; ifMatch?: string }[] = [];
    const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: init!.body as Uint8Array, ifMatch: (init!.headers as Record<string, string> | undefined)?.["If-Match"] });
      return new Response(null, { status: 204 });
    }) as typeof fetch });
    const payload = signDidDhtPacket(id, encodeDidDhtPacket(didDhtDocument(id.publicKey)), 1_790_000_000);
    await relay.publishPayload(id.pubKeyZ32, payload, { background: true });
    await relay.publishPayload(id.pubKeyZ32, payload);
    expect(seen.map((s) => s.url)).toEqual([`https://a.test/${id.pubKeyZ32}`, `https://b.test/${id.pubKeyZ32}`, `https://a.test/${id.pubKeyZ32}`, `https://b.test/${id.pubKeyZ32}`]);
    for (const s of seen) expect(s.body).toEqual(payload);
    expect(seen.map((s) => s.ifMatch)).toEqual([undefined, undefined, "1790000000", "1790000000"]);
    await expect(relay.publishPayload(createIdentity().pubKeyZ32, payload)).rejects.toThrow("Invalid signature");
    await expect(new RelayTransport({ relays: [], fetch: vi.fn() }).publishPayload(id.pubKeyZ32, payload)).rejects.toThrow("No Pkarr relays configured");
  });

  it("uses strictly increasing sequence numbers even within one millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const stamps: bigint[] = [];
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init!.body as Uint8Array;
      stamps.push(new DataView(body.buffer, body.byteOffset + 64, 8).getBigUint64(0));
      return new Response(null, { status: 204 });
    }) as typeof fetch });
    for (let i = 0; i < 3; i++) await relay.publish(id, []);
    expect(stamps[1]).toBe(stamps[0] + 1n);
    expect(stamps[2]).toBe(stamps[0] + 2n);
  });

  it("succeeds when one relay accepts, and reports every relay's failure when none does", async () => {
    const ok = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async (url: RequestInfo | URL) =>
      new Response(null, { status: String(url).includes("a.test") ? 500 : 204 })) as typeof fetch });
    await expect(ok.publish(id, [])).resolves.toBeUndefined();
    const down = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async () => new Response(null, { status: 503 })) as typeof fetch });
    await expect(down.publish(id, [])).rejects.toThrow(/Publish failed on every relay: .*a\.test responded 503.*b\.test responded 503/);
  });

  it("refuses records too large for a packet before any request", async () => {
    const fetchMock = vi.fn();
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: fetchMock });
    await expect(relay.publish(id, [{ label: "_big", value: "x".repeat(2000) }])).rejects.toThrow(/too large/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cools a relay down for 15 seconds after a 429 without a usable Retry-After, and for at most two minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [retryAfter, seconds] of [[null, 15], ["soon", 15], ["0", 1], ["9999", 120]] as const) {
      let calls = 0;
      const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => {
        calls++;
        return new Response(null, { status: 429, headers: retryAfter === null ? {} : { "retry-after": retryAfter } });
      }) as typeof fetch });
      await expect(relay.publish(id, [])).rejects.toThrow();
      vi.setSystemTime(Date.now() + seconds * 1000 - 1);
      await expect(relay.publish(id, [])).rejects.toThrow("cooling down");
      expect(calls).toBe(1);
      vi.setSystemTime(Date.now() + 2);
      await expect(relay.publish(id, [])).rejects.toThrow("responded 429");
      expect(calls).toBe(2);
    }
  });
});

describe("resolving", () => {
  it("gives up on a relay that does not answer within the timeout and tries the next", async () => {
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://b.test"], timeoutMs: 5, fetch: ((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("b.test")) return Promise.resolve(packet(4n));
      return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as typeof fetch });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(4n);
  });

  it("treats a malformed or forged packet as a failed relay and tries the next", async () => {
    const relay = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: (async (url: RequestInfo | URL) =>
      String(url).includes("a.test") ? new Response(new Uint8Array(10) as BodyInit) : packet(6n)) as typeof fetch });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(6n);
  });

  it("never replaces a newer packet with an older one", async () => {
    let next = 9n;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => packet(next)) as typeof fetch });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(9n);
    next = 3n;
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(9n);
    next = 12n;
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(12n);
  });

  it("answers from what it knows while every relay is cooling down, and fails if it knows nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let limited = false;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () =>
      limited ? new Response(null, { status: 429, headers: { "retry-after": "30" } }) : packet(8n)) as typeof fetch });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(8n);
    limited = true;
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(8n);
    // Knowing nothing, it says the read waits for the relay's Retry-After: a wait, not an outage.
    await expect(relay.resolve(createIdentity().pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
  });

  it("recovers a relay once its budget window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let requests = 0;
    const relay = new RelayTransport({ relays: ["https://a.test"], fetch: (async () => { requests++; return packet(1n); }) as typeof fetch });
    for (let i = 0; i < 31; i++) await relay.resolve(id.pubKeyZ32);
    expect(requests).toBe(30);
    vi.setSystemTime(Date.now() + 60_000);
    await relay.resolve(id.pubKeyZ32);
    expect(requests).toBe(31);
  });
});

describe("publishing past a slow relay", () => {
  /** A fetch whose answers are held on the hosts in `slow` until `release` hands each one its response. */
  function gated(answer: (host: string, init: RequestInit, attempt: number) => Response, slow: string[]) {
    const held: { host: string; resolve: (response: Response) => void; init: RequestInit }[] = [];
    const attempts = new Map<string, number>();
    const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(String(url)).host;
      const attempt = (attempts.get(host) ?? 0) + 1;
      attempts.set(host, attempt);
      if (!slow.includes(host)) return Promise.resolve(answer(host, init!, attempt));
      return new Promise<Response>((resolve, reject) => {
        held.push({ host, init: init!, resolve: (response) => resolve(response) });
        init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
    const release = (answerFor: (init: RequestInit) => Response) => { for (const h of held.splice(0)) h.resolve(answerFor(h.init)); };
    return { fetchFn, attempts, release, held };
  }
  const settleSoon = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("returns once one relay took the packet, while a slow one is still answering", async () => {
    const { fetchFn, held, release } = gated(() => new Response(null, { status: 204 }), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], fetch: fetchFn });
    await relay.publish(id, []);
    // Out on fast.test; slow.test still holds its request.
    expect(held.map((h) => h.host)).toEqual(["slow.test"]);
    release(() => new Response(null, { status: 204 }));
  });

  it("keeps the slow relay's put going: its 412 is retried without If-Match after the publish returned", async () => {
    const { fetchFn, attempts, held, release } = gated(() => new Response(null, { status: 204 }), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], fetch: fetchFn });
    await relay.publish(id, []);
    release(() => new Response(null, { status: 204 }));
    await settleSoon();
    // The next publish replaces the first one: slow.test never got it and says 412.
    await relay.publish(id, []);
    expect((held[0].init.headers as Record<string, string>)["If-Match"]).toBeDefined();
    release(() => new Response(null, { status: 412 }));
    await settleSoon();
    expect(attempts.get("slow.test")).toBe(3);
    expect(held[0].init.headers).toBeUndefined();
    release(() => new Response(null, { status: 204 }));
  });

  it("counts a slow relay's timeout after the publish returned: it is left alone for the next one", async () => {
    const { fetchFn, attempts } = gated(() => new Response(null, { status: 204 }), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], timeoutMs: 5, fetch: fetchFn });
    await relay.publish(id, []);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await relay.publish(id, []);
    // The first PUT to slow.test timed out after the publish returned; the second publish skipped it.
    expect(attempts.get("slow.test")).toBe(1);
    expect(attempts.get("fast.test")).toBe(2);
  });

  it("lets reads go on a relay that refused the write as soon as another took it, the slow one still answering", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const gets: string[] = [];
    const { fetchFn, release } = gated((host, init) => {
      if (init.method === "PUT") return new Response(null, { status: 204 });
      gets.push(host); return packet(3n);
    }, ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://a.test", "https://fast.test", "https://slow.test"], requestsPerMinute: 1, fetch: fetchFn });
    const start = Date.now();
    // A read fills a's minute; near its end a refuses a link's packet, fast.test takes it, slow.test holds it.
    await relay.resolve(id.pubKeyZ32);
    vi.setSystemTime(start + 58_000);
    await relay.publish(id, []);
    // a's minute frees up while slow.test still answers: the packet is out, so a has no write to let go first.
    vi.setSystemTime(start + 60_500);
    await relay.resolve(id.pubKeyZ32);
    expect(gets).toEqual(["a.test", "a.test"]);
    release(() => new Response(null, { status: 204 }));
  });

  it("fails when every relay fails, waiting for the slow one to say why", async () => {
    const { fetchFn, release } = gated(() => new Response(null, { status: 503 }), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], fetch: fetchFn });
    let outcome: unknown = "pending";
    const publishing = relay.publish(id, []).then(() => "published", (error: unknown) => error);
    void publishing.then((value) => { outcome = value; });
    await settleSoon();
    // fast.test failed at once, but slow.test may still take it.
    expect(outcome).toBe("pending");
    release(() => new Response(null, { status: 500 }));
    const error = await publishing;
    expect(error).toBeInstanceOf(Error);
    expect(isDiscoveryBudgetError(error)).toBe(false);
    expect((error as Error).message).toMatch(/Publish failed on every relay: .*slow\.test responded 500.*fast\.test responded 503/);
  });

  it("is a wait for the soonest relay when every one held it back for its budget", async () => {
    const limited = (seconds: number) => new Response(null, { status: 429, headers: { "retry-after": String(seconds) } });
    const { fetchFn, release } = gated(() => limited(40), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], fetch: fetchFn });
    const publishing = relay.publish(id, []).then(() => null, (error: unknown) => error);
    await settleSoon();
    release(() => limited(25));
    const error = await publishing;
    expect(error).toBeInstanceOf(DiscoveryBudgetError);
    expect((error as DiscoveryBudgetError).retryInMs).toBe(25_000);
    expect((error as Error).message).toContain("Publish held back on every relay");
  });

  it("is a failure, not a wait, when a slow relay fails where the other held it back", async () => {
    const { fetchFn, release } = gated(() => new Response(null, { status: 429, headers: { "retry-after": "20" } }), ["slow.test"]);
    const relay = new RelayTransport({ relays: ["https://slow.test", "https://fast.test"], fetch: fetchFn });
    const publishing = relay.publish(id, []).then(() => null, (error: unknown) => error);
    await settleSoon();
    release(() => new Response(null, { status: 502 }));
    const error = await publishing;
    expect(isDiscoveryBudgetError(error)).toBe(false);
    expect((error as Error).message).toContain("Publish failed on every relay");
  });
});
