import { describe, expect, it } from "vitest";
import { RelayTransport, createIdentity, createRelayPayload } from "../src";

describe("relay transport", () => {
  const id = createIdentity();
  const packet = (micros: bigint) => createRelayPayload(id, [{ label: "_ts", value: String(micros) }], micros);

  function transport(handlers: Record<string, () => Response>) {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const host = new URL(String(input)).host;
      calls.push(host);
      return handlers[host]();
    }) as typeof fetch;
    return { calls, relay: new RelayTransport({ relays: Object.keys(handlers).map((h) => `https://${h}`), fetch: fetchFn }) };
  }

  it("spends one request per poll, taking relays in turn, and keeps the newest packet", async () => {
    const { relay, calls } = transport({
      "a.test": () => new Response(packet(2000n) as BodyInit),
      "b.test": () => new Response(packet(1000n) as BodyInit),
    });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(2000n);
    // b still serves an older cached copy; the newer one already seen wins
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(2000n);
    expect(calls).toEqual(["a.test", "b.test"]);
  });

  it("backs off from a relay that rate limits and uses the other one", async () => {
    const { relay, calls } = transport({
      "a.test": () => new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      "b.test": () => new Response(packet(5n) as BodyInit),
    });
    expect((await relay.resolve(id.pubKeyZ32))?.timestampMicros).toBe(5n);
    await relay.resolve(id.pubKeyZ32);
    await relay.resolve(id.pubKeyZ32);
    expect(calls).toEqual(["a.test", "b.test", "b.test", "b.test"]);
  });

  it("reports nothing published, and fails only when no relay answers", async () => {
    const missing = transport({ "a.test": () => new Response(null, { status: 404 }) });
    expect(await missing.relay.resolve(id.pubKeyZ32)).toBeNull();

    const down = transport({ "a.test": () => new Response(null, { status: 502 }) });
    await expect(down.relay.resolve(id.pubKeyZ32)).rejects.toThrow("No Pkarr relay reachable");
  });

  it("ignores a packet with a bad signature", async () => {
    const forged = createRelayPayload(createIdentity(), [{ label: "_ts", value: "1" }]);
    const { relay } = transport({ "a.test": () => new Response(forged as BodyInit) });
    await expect(relay.resolve(id.pubKeyZ32)).rejects.toThrow();
  });
});
