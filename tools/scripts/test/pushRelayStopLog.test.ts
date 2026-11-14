import { afterEach, describe, expect, it, vi } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

/**
 * The push relay's counts when it stops (infra/services/push-relay `close`): every forward and failure that ends while
 * it waits for the open requests is in a line before it stops, and a forward it cuts is said as a count. The counts
 * were written before that wait, so the ones ending in it were in no line.
 */
const body = Buffer.from("encrypted").toString("base64url");
const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });

describe("the push relay's log when it stops (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  // A forward the fake push service holds until the test lets it go.
  const held: (() => void)[] = [];
  afterEach(async () => {
    for (const release of held.splice(0)) release();
    await close?.();
    close = undefined;
    vi.unstubAllGlobals();
  });

  /**
   * A relay whose push service is a stub on `https://127.0.0.1/`: `/ok` answers 201 at once, `/slow` 201 after 150 ms,
   * `/reset` fails as a dropped connection after 150 ms, `/stuck` answers only when the test releases it.
   */
  async function relayWithPushService() {
    const lines: string[] = [];
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], proxies: 1, log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const real = globalThis.fetch;
    let calls = 0;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://127.0.0.1/")) return real(input, init);
      calls++;
      if (url.endsWith("/ok")) return Promise.resolve(new Response(null, { status: 201 }));
      if (url.endsWith("/stuck")) return new Promise<Response>((done) => held.push(() => done(new Response(null, { status: 201 }))));
      return new Promise<Response>((done, fail) => setTimeout(() => (url.endsWith("/reset") ? fail(reset()) : done(new Response(null, { status: 201 }))), 150));
    });
    let n = 0;
    // Each from its own address, as many clients behind one proxy: the per-address limit never applies.
    const post = (path: string) => fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `10.0.0.${++n}` },
      body: JSON.stringify({ endpoint: `https://127.0.0.1/${path}`, headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
    }).then((response) => response.status, () => "cut");
    /** Resolves once the push service has been asked `count` times in all. */
    const asked = async (count: number) => { while (calls < count) await new Promise((done) => setTimeout(done, 10)); };
    return { relay, lines, post, asked };
  }

  it("counts every forward and failure that ends while it waits for the open requests", async () => {
    const { relay, lines, post, asked } = await relayWithPushService();
    expect(await post("ok")).toBe(200);
    expect(await post("ok")).toBe(200);
    const inFlight = [post("slow"), post("slow"), post("slow"), post("slow"), post("reset"), post("reset")];
    await asked(8);
    await relay.close({ stopMs: 1000 });
    close = undefined;
    // They all ended in the wait, before the cut.
    expect(await Promise.all(inFlight)).toEqual([200, 200, 200, 200, 502, 502]);
    expect(lines).toEqual(["forwarded 201", "failed ECONNRESET", "forwarded 201 5 more", "failed ECONNRESET 1 more"]);
  });

  it("with nothing in flight, writes the counts once", async () => {
    const { relay, lines, post } = await relayWithPushService();
    for (let i = 0; i < 3; i++) expect(await post("ok")).toBe(200);
    expect(lines).toEqual(["forwarded 201"]);
    await relay.close();
    close = undefined;
    expect(lines).toEqual(["forwarded 201", "forwarded 201 2 more"]);
  });

  it("when the wait runs out, counts what ended and says how many forwards it cut", async () => {
    const { relay, lines, post, asked } = await relayWithPushService();
    expect(await post("ok")).toBe(200);
    const inFlight = [post("slow"), post("slow"), post("stuck")];
    await asked(4);
    await relay.close({ stopMs: 500 });
    close = undefined;
    expect(await Promise.all(inFlight)).toEqual([200, 200, "cut"]);
    expect(lines).toEqual(["forwarded 201", "forwarded 201 2 more", "cut 1 forward in flight"]);
  });
});
