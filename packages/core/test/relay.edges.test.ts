import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createRelayPayload } from "../src/pkarr";
import { DEFAULT_RELAYS, RelayTransport, normalizeRelayUrl } from "../src/relay";

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
    await expect(relay.resolve(createIdentity().pubKeyZ32)).rejects.toThrow("No Pkarr relay reachable");
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
