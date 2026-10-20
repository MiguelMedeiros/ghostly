import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayTransport, createIdentity } from "../src";
import type { PkarrRequestOptions } from "../src/transport";
// covers: core.relay-client

/**
 * A group edge's offer or answer goes to every relay and the publish settles once one took it. A relay that failed it
 * (an error of its own, no answer) kept the edge's older offer until its next packet, and one whose budget held it back
 * got it later as a background write, behind community looks and the chats' reserve: a member reading that relay
 * answered the old offer, or found none, and the edge waited out its backoff. Now that relay gets it again, once, on
 * the edges' own floor, so the signal is on two relays.
 */
describe("a group edge's signal goes to two relays", () => {
  const edge = createIdentity();
  const EDGE: PkarrRequestOptions = { group: true, signal: true };
  afterEach(() => { vi.useRealTimers(); });

  /** Relays that keep the packet put last under each key. `fail`: how a relay answers the edge's next PUT. */
  function relays(hosts: string[]) {
    const held = new Map<string, Uint8Array>();
    const log: { host: string; method: string; key: string }[] = [];
    const fail = new Map<string, "once" | "always" | "no answer">();
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), key = url.pathname.slice(1);
      log.push({ host: url.host, method: init?.method ?? "GET", key });
      if (init?.method === "PUT") {
        const how = key === edge.pubKeyZ32 ? fail.get(url.host) : undefined;
        if (how && how !== "always") fail.delete(url.host);
        if (how === "no answer") throw new TypeError("Failed to fetch");
        if (how) return new Response(null, { status: 500 });
        held.set(`${url.host} ${key}`, new Uint8Array(init.body as Uint8Array));
        return new Response(null, { status: 204 });
      }
      const body = held.get(`${url.host} ${key}`);
      return body ? new Response(body as BodyInit) : new Response(null, { status: 404 });
    }) as typeof fetch;
    const transport = new RelayTransport({ freshReadMs: 0, relays: hosts.map(h => `https://${h}`), fetch: fetchFn, log: () => {} });
    /** What a member reading only `host` finds under the edge's key. */
    const read = async (host: string) => {
      const member = new RelayTransport({ freshReadMs: 0, relays: [`https://${host}`], fetch: fetchFn, log: () => {} });
      return (await member.resolve(edge.pubKeyZ32, { group: true }))?.records.find(r => r.label === "_sig")?.value ?? null;
    };
    const putsOf = (host: string, key = edge.pubKeyZ32) => log.filter(r => r.method === "PUT" && r.host === host && r.key === key).length;
    return { transport, fail, read, putsOf };
  }
  const offer = (value: string) => [{ label: "_sig", value }];

  it("two relays, the first failing the edge's new offer (500): a member reading either one gets it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, fail, read } = relays(["a.test", "b.test"]);
    await transport.publish(edge, offer("old"), EDGE);
    await vi.advanceTimersByTimeAsync(1_000);
    fail.set("a.test", "once");
    await transport.publish(edge, offer("new"), EDGE);
    expect(await read("b.test")).toBe("new");
    await vi.advanceTimersByTimeAsync(2_000);
    // Before: a.test kept the old offer until the edge's next packet.
    expect(await read("a.test")).toBe("new");
  });

  it("two relays, the first not answering: it gets the offer once its network cooldown is over", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, fail, read, putsOf } = relays(["a.test", "b.test"]);
    await transport.publish(edge, offer("old"), EDGE);
    await vi.advanceTimersByTimeAsync(1_000);
    fail.set("a.test", "no answer");
    await transport.publish(edge, offer("new"), EDGE);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(putsOf("a.test"), "nothing asked of it while it cools down").toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await read("a.test")).toBe("new");
    expect(await read("b.test")).toBe("new");
  });

  it("held back by one relay's budget: it goes there on the edges' floor once that frees, not behind the background looks", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, read, putsOf } = relays(["b.test"]);
    const t0 = Date.now();
    // b.test's minute: the edges' floor spent first (4 of 30), then background looks, chats' writes and their signals.
    for (let i = 0; i < 4; i++) await transport.publish(createIdentity(), offer("x"), EDGE);
    await vi.advanceTimersByTimeAsync(30_000);
    for (let i = 0; i < 20; i++) await transport.publish(createIdentity(), offer("x"), { background: true });
    for (let i = 0; i < 6; i++) await transport.publish(createIdentity(), offer("x"));
    for (let i = 0; i < 4; i++) await transport.publish(createIdentity(), offer("x"), { signal: true });
    await vi.advanceTimersByTimeAsync(20_000);
    transport.setRelays(["https://a.test", "https://b.test"]);
    await transport.publish(edge, offer("new"), EDGE);
    expect(await read("a.test")).toBe("new");
    expect(putsOf("b.test"), "held back there").toBe(0);
    await vi.advanceTimersByTimeAsync(t0 + 59_000 - Date.now());
    expect(putsOf("b.test"), "the edges' floor is still spent").toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    // Before: a background write, which waited for the chats' requests of the minute to age out, 30 s more.
    expect(await read("b.test")).toBe("new");
    expect(putsOf("b.test")).toBe(1);
  });

  it("a relay that fails it again gets it once more at most", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, fail, putsOf } = relays(["a.test", "b.test"]);
    fail.set("a.test", "always");
    await transport.publish(edge, offer("new"), EDGE);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(putsOf("a.test")).toBe(2);
    expect(putsOf("b.test")).toBe(1);
  });

  it("one relay configured: one PUT, and a failure fails the publish as before, with nothing put later", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, fail, putsOf } = relays(["a.test"]);
    await transport.publish(edge, offer("old"), EDGE);
    expect(putsOf("a.test")).toBe(1);
    fail.set("a.test", "once");
    await expect(transport.publish(edge, offer("new"), EDGE)).rejects.toThrow(/500/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(putsOf("a.test")).toBe(2);
  });

  it("a 1:1 chat's packet one relay failed is not put there again (its next packet goes)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { transport, fail, putsOf } = relays(["a.test", "b.test"]);
    fail.set("a.test", "once");
    await transport.publish(edge, offer("new"), { signal: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(putsOf("a.test")).toBe(1);
  });
});
