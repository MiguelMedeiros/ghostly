import { afterEach, describe, expect, it, vi } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

/**
 * The relay's per-minute counts read a monotonic clock: the host's wall clock stepped (an NTP step, a resumed VM, an
 * operator fixing the time) neither keeps a sender refused for the whole step nor frees it before its minute is over.
 */

const HOUR = 3_600_000;
const body = Buffer.from("encrypted").toString("base64url");

/** The wall clock, from now on, `ms` off where it is (negative: set back). */
const stepClock = (ms: number) => {
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + ms);
};
/** `ms` more of real time gone by, as a monotonic clock sees it. */
const elapse = (ms: number) => {
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + ms);
};

describe("the push relay's per-minute limits across a clock step (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await close?.(); close = undefined; vi.unstubAllGlobals(); });

  // The push service, on loopback: every post to it is a 201. Nothing leaves the machine.
  const relayed = async (limits: Record<string, number>) => {
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], proxies: 1, limits });
    close = relay.close;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (!String(input).startsWith("https://127.0.0.1/")) return real(input, init);
      return Promise.resolve(new Response(null, { status: 201 }));
    });
    const post = async (address: number) => (await fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `10.0.0.${address}` },
      body: JSON.stringify({ endpoint: "https://127.0.0.1/sub/one", headers: { Authorization: "vapid t=a.b.c, k=K", TTL: "60" }, body }),
    })).status;
    return post;
  };

  it("accepts an address again a minute after it used its limit, though the clock was set back an hour meanwhile", async () => {
    const post = await relayed({ perMinute: 2, perEndpoint: 100 });
    expect([await post(1), await post(1), await post(1)]).toEqual([200, 200, 429]);
    // A minute and a second go by while the wall clock is set back an hour.
    elapse(61_000);
    stepClock(-(HOUR - 61_000));
    expect(await post(1)).toBe(200);
  });

  it("accepts a subscription again a minute after it used its limit, though the clock was set back an hour meanwhile", async () => {
    const post = await relayed({ perMinute: 100, perEndpoint: 2 });
    expect([await post(1), await post(2), await post(3)]).toEqual([200, 200, 429]);
    elapse(61_000);
    stepClock(-(HOUR - 61_000));
    expect(await post(4)).toBe(200);
  });

  it("still refuses an address and a subscription within their minute when the clock is set forward an hour", async () => {
    const post = await relayed({ perMinute: 2, perEndpoint: 3 });
    expect([await post(1), await post(1), await post(1)]).toEqual([200, 200, 429]);
    expect(await post(2)).toBe(200);
    stepClock(HOUR);
    // The same second, by a monotonic clock: both counts are still full.
    expect(await post(1)).toBe(429);
    expect(await post(3)).toBe(429);
  });
});
