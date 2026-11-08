import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's limit per push endpoint (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; vi.unstubAllGlobals(); });

  // The push service, on loopback: every post to it is a 201, counted by endpoint. Nothing leaves the machine.
  const relayed = async (limits: Record<string, number>) => {
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], proxies: 1, limits });
    close = relay.close;
    const real = globalThis.fetch;
    const delivered = new Map<string, number>();
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://127.0.0.1/")) return real(input, init);
      delivered.set(url, (delivered.get(url) ?? 0) + 1);
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    // Each from an address of its own, as clients behind one proxy, all with the same endpoint and VAPID token.
    const post = (address: number, endpoint = "https://127.0.0.1/sub/one", key = "K") => fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `10.0.${address >> 8}.${address & 255}` },
      body: JSON.stringify({ endpoint, headers: { Authorization: `vapid t=a.b.c, k=${key}`, TTL: "60" }, body }),
    });
    return { relay, delivered, post };
  };

  it("forwards no more to one endpoint than its own limit, however many addresses send", async () => {
    const { relay, delivered, post } = await relayed({ perMinute: 2, perEndpoint: 5 });
    const statuses: number[] = [];
    for (let address = 0; address < 50; address++) for (let n = 0; n < 2; n++) statuses.push((await post(address)).status);
    expect(statuses.filter(status => status === 200)).toHaveLength(5);
    expect(statuses.filter(status => status === 429)).toHaveLength(95);
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(5);
    expect(relay.stats()).toMatchObject({ forwarded: 5, refused: 95 });
  });

  it("counts a subscription by its endpoint and VAPID key, so a sender with another key does not spend its limit", async () => {
    // A key the subscription was not made with is refused by the push service: it wakes nothing there.
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2 });
    for (let n = 0; n < 5; n++) await post(n, "https://127.0.0.1/sub/one", `Other${n}`);
    expect((await post(9)).status).toBe(200);
    expect((await post(9)).status).toBe(200);
    expect((await post(9)).status).toBe(429);
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(7);
  });

  it("counts an endpoint however its URL is spelt, and leaves other endpoints their own limit", async () => {
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2 });
    expect((await post(1, "https://127.0.0.1/sub/one")).status).toBe(200);
    expect((await post(2, "HTTPS://127.0.0.1:443/sub/./one")).status).toBe(200);
    expect((await post(3, "https://127.0.0.1/sub/one")).status).toBe(429);
    expect((await post(3, "https://127.0.0.1/sub/two")).status).toBe(200);
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(2);
    expect(delivered.get("https://127.0.0.1/sub/two")).toBe(1);
  });

  it("at its defaults, bounds one endpoint below what a few dozen addresses could send", async () => {
    const { delivered, post } = await relayed({});
    for (let address = 0; address < 4; address++) for (let n = 0; n < DEFAULT_LIMITS.perMinute; n++) await post(address);
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(DEFAULT_LIMITS.perEndpoint);
    expect(DEFAULT_LIMITS.perEndpoint).toBeLessThan(4 * DEFAULT_LIMITS.perMinute);
  });

  it("a full table of endpoints forgets the one seen longest ago, not every newcomer", async () => {
    const { relay, post } = await relayed({ perMinute: 100, perEndpoint: 1, tracked: 3 });
    for (const path of ["a", "b", "c", "d"]) expect((await post(1, `https://127.0.0.1/${path}`)).status).toBe(200);
    expect(relay.endpoints()).toBe(3);
    expect((await post(1, "https://127.0.0.1/d")).status).toBe(429);
    expect((await post(1, "https://127.0.0.1/a")).status).toBe(200);
  });
});
