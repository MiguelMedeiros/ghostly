import { afterEach, describe, expect, it, vi } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's log of forwards (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; vi.unstubAllGlobals(); });

  it("logs forwards and failures as counts, a line per status or cause a minute, however many clients push", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], proxies: 1, log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const real = globalThis.fetch;
    // The push service: 201 for /ok, 404 for a made-up endpoint, nobody home for /down.
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://127.0.0.1/")) return real(input, init);
      if (url.endsWith("/down")) return Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
      return Promise.resolve(new Response(null, { status: url.endsWith("/ok") ? 201 : 404 }));
    });
    const url = `http://127.0.0.1:${relay.port}/`;
    // Each from its own address, as many clients behind one proxy: the per-address limit never applies.
    const post = (n: number, path: string) => fetch(url, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": `10.0.${n >> 8}.${n & 255}` },
      body: JSON.stringify({ endpoint: `https://127.0.0.1/${path}`, headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
    });
    for (let n = 0; n < 60; n++) expect((await post(n, n % 3 === 0 ? "made-up" : "ok")).status).toBe(200);
    for (let n = 60; n < 65; n++) expect((await post(n, "down")).status).toBe(502);
    expect(lines).toEqual(["forwarded 404", "forwarded 201", "failed ECONNREFUSED"]);
    expect(relay.stats()).toMatchObject({ forwarded: 60, failed: 5, refused: 0 });
    await relay.close();
    close = undefined;
    expect(lines).toEqual(["forwarded 404", "forwarded 201", "failed ECONNREFUSED", "forwarded 404 19 more", "forwarded 201 39 more", "failed ECONNREFUSED 4 more"]);
  });
});
