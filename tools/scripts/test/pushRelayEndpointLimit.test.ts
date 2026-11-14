import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's limit per push endpoint (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; vi.unstubAllGlobals(); });

  // The push service, on loopback: every post to it is counted by endpoint and answered `status` (201 unless the
  // test says otherwise for its token). Nothing leaves the machine.
  const relayed = async (limits: Record<string, number>, status = (_token: string) => 201) => {
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/, /(^|\.)notify\.windows\.com$/], proxies: 1, limits });
    close = relay.close;
    const real = globalThis.fetch;
    const delivered = new Map<string, number>();
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://127.0.0.1/") && !url.startsWith("https://wns.notify.windows.com/")) return real(input, init);
      delivered.set(url, (delivered.get(url) ?? 0) + 1);
      const token = /t=([^,]+)/.exec(String((init?.headers as Record<string, string>).Authorization))?.[1] ?? "";
      return Promise.resolve(new Response(null, { status: status(token) }));
    });
    // Each from an address of its own, as clients behind one proxy, all with the same endpoint and VAPID token.
    const post = (address: number, endpoint = "https://127.0.0.1/sub/one", key = "K", token = "a.b.c") => fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `10.0.${address >> 8}.${address & 255}` },
      body: JSON.stringify({ endpoint, headers: { Authorization: `vapid t=${token}, k=${key}`, TTL: "60" }, body }),
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

  it("a forward the push service refuses does not spend the subscription's minute, so contacts still wake it", async () => {
    // A token the push service does not accept (no valid VAPID signature): it answers 403 and wakes nothing.
    const { delivered, post } = await relayed({}, token => (token.startsWith("bad") ? 403 : 201));
    const refused: number[] = [];
    for (let n = 0; n < DEFAULT_LIMITS.perMinute; n++) {
      const response = await post(1, undefined, undefined, `bad.${n}.x`);
      refused.push((await response.json()).status);
    }
    expect(refused).toEqual(Array(DEFAULT_LIMITS.perMinute).fill(403));
    // That one address has spent its own minute, and only that.
    expect((await post(1, undefined, undefined, "bad.more.x")).status).toBe(429);
    for (const address of [2, 3, 4]) {
      const response = await post(address);
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe(201);
    }
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(DEFAULT_LIMITS.perMinute + 3);
  });

  it("gives back only what the push service refused for the request itself: a full minute of accepted ones stays full", async () => {
    const statuses = [404, 410, 401, 400, 429, 500];
    let next = 0;
    const { post } = await relayed({ perMinute: 100, perEndpoint: 3 }, () => statuses[next++] ?? 201);
    const answered: number[] = [];
    for (let n = 0; n < 7; n++) {
      const response = await post(n);
      answered.push(response.status === 200 ? (await response.json()).status : response.status);
    }
    // The four refusals are given back; the push service's 429 and 500 are not (it may be swamped, the push may have gone).
    expect(answered).toEqual([404, 410, 401, 400, 429, 500, 201]);
    expect((await post(8)).status).toBe(429);
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

  it("counts an endpoint as the push service receives it: a fragment or an empty query is no new budget", async () => {
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2 });
    expect((await post(1, "https://127.0.0.1/sub/one")).status).toBe(200);
    expect((await post(2, "https://127.0.0.1/sub/one#1")).status).toBe(200);
    for (const endpoint of ["https://127.0.0.1/sub/one?", "https://127.0.0.1/sub/one#2", "https://127.0.0.1/sub/one?#", "https://127.0.0.1/sub/one#"]) {
      expect((await post(3, endpoint)).status).toBe(429);
    }
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(2);
    expect([...delivered.keys()]).toEqual(["https://127.0.0.1/sub/one"]);
  });

  it("at its defaults, 60 addresses each with its own fragment forward 30 to one endpoint, not 60", async () => {
    const { delivered, post } = await relayed({});
    const statuses: number[] = [];
    for (let address = 0; address < 60; address++) statuses.push((await post(address, `https://127.0.0.1/sub/one#${address}`)).status);
    expect(statuses.filter(status => status === 200)).toHaveLength(DEFAULT_LIMITS.perEndpoint);
    expect([...delivered.values()].reduce((sum, n) => sum + n, 0)).toBe(DEFAULT_LIMITS.perEndpoint);
  });

  it("counts an endpoint as the push service routes it: a query or a percent-spelt path is refused, not a new budget", async () => {
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2 });
    expect((await post(1, "https://127.0.0.1/sub/one")).status).toBe(200);
    // The push service routes on the path, percent-decoded, and reads no query: each of these is the same subscription.
    for (const endpoint of ["https://127.0.0.1/sub/one?1", "https://127.0.0.1/sub/one?x=1", "https://127.0.0.1/sub/%6Fne", "https://127.0.0.1/%73ub/one"]) {
      const response = await post(2, endpoint);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Not a push endpoint" });
    }
    expect((await post(3, "https://127.0.0.1/sub/one")).status).toBe(200);
    expect((await post(4, "https://127.0.0.1/sub/one")).status).toBe(429);
    expect([...delivered.entries()]).toEqual([["https://127.0.0.1/sub/one", 2]]);
  });

  it("at its defaults, 60 addresses each with its own query or spelling forward 30 to one endpoint, not 60", async () => {
    const spellings = [(n: number) => `?${n}`, (n: number) => `?x=${n}`, (n: number) => (n % 2 ? "" : "?")];
    for (const spelling of spellings) {
      const { delivered, post } = await relayed({});
      for (let address = 0; address < 60; address++) await post(address, `https://127.0.0.1/sub/one${spelling(address)}`);
      expect([...delivered.values()].reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(DEFAULT_LIMITS.perEndpoint);
      await close?.();
      close = undefined;
    }
  });

  it("forwards a WNS endpoint, its one token counted however it is spelt", async () => {
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2 });
    expect((await post(1, "https://wns.notify.windows.com/w/?token=AbC%2bd%3d")).status).toBe(200);
    expect((await post(2, "https://wns.notify.windows.com/w/?token=AbC%2Bd%3D&")).status).toBe(200);
    expect((await post(3, "https://wns.notify.windows.com/w/?token=%41bC%2Bd=")).status).toBe(429);
    expect((await post(3, "https://wns.notify.windows.com/w/?token=Other")).status).toBe(200);
    for (const endpoint of ["https://wns.notify.windows.com/w/?token=AbC%2bd%3d&token=x", "https://wns.notify.windows.com/w/?token=AbC%2bd%3d&x=1",
      "https://wns.notify.windows.com/w/?x=AbC", "https://wns.notify.windows.com/w/?token=", "https://wns.notify.windows.com/%77/?token=Other"]) {
      expect((await post(4, endpoint)).status).toBe(400);
    }
    expect([...delivered.values()].reduce((sum, n) => sum + n, 0)).toBe(3);
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

  it("a full table keeps an endpoint at its limit and forgets one under it, so newcomers do not start its minute over", async () => {
    const { delivered, post } = await relayed({ perMinute: 100, perEndpoint: 2, tracked: 3 });
    expect((await post(1)).status).toBe(200);
    expect((await post(2)).status).toBe(200);
    expect((await post(3)).status).toBe(429);
    // Newcomers enough to fill the table past it, one forward each: the endpoint at its limit is now the one seen longest ago.
    for (const path of ["b", "c", "d", "e"]) expect((await post(10, `https://127.0.0.1/${path}`)).status).toBe(200);
    expect((await post(4)).status).toBe(429);
    expect(delivered.get("https://127.0.0.1/sub/one")).toBe(2);
  });
});
