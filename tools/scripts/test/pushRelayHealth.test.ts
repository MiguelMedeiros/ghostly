import { afterEach, describe, expect, it, vi } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's health check (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("answers GET /healthz with 200 and no count, without an Origin, and refuses any other GET", async () => {
    // The "push service" is 127.0.0.1:443, where nothing listens: every forward fails.
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/] });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}`;
    const post = (endpoint: string) => fetch(`${url}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools" },
      body: JSON.stringify({ endpoint, headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
    });
    const fresh = await fetch(`${url}/healthz`);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("cache-control")).toBe("no-store");
    expect(await fresh.json()).toEqual({ ok: true });
    expect((await post("https://127.0.0.1/x")).status).toBe(502);
    expect((await post("https://example.com/x")).status).toBe(400);
    expect((await fetch(`${url}/`)).status).toBe(405);
    expect((await fetch(`${url}/status`)).status).toBe(405);
    expect(await (await fetch(`${url}/healthz?probe=1`)).json()).toEqual({ ok: true });
    expect(relay.stats()).toEqual({ forwarded: 0, failed: 1, refused: 3, tracked: 1 });
  });

  it("answers a monitor's HEAD /healthz as its GET, with no body and no refusal in the log", async () => {
    const logged: string[] = [];
    const relay = await startRelay({ log: (...words: string[]) => { logged.push(words.join(" ")); } });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}`;
    for (const path of ["/healthz", "/healthz?x=1"]) {
      const head = await fetch(`${url}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("cache-control")).toBe("no-store");
      expect(await head.text()).toBe("");
    }
    expect(relay.stats()).toMatchObject({ refused: 0 });
    await close();
    close = undefined;
    expect(logged.filter((line) => line.includes("refused"))).toEqual([]);
  });

  it("reads the same to a stranger before and after an allowed client's push", async () => {
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], origins: ["https://app.example"] });
    close = relay.close;
    const real = globalThis.fetch;
    // The push service takes the wake.
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => (String(input).startsWith("https://127.0.0.1/")
      ? Promise.resolve(new Response(null, { status: 201 }))
      : real(input, init)));
    try {
      const url = `http://127.0.0.1:${relay.port}`;
      const read = async () => (await fetch(`${url}/healthz`, { headers: { Origin: "https://stranger.example" } })).json();
      const before = await read();
      const wake = await fetch(`${url}/`, {
        method: "POST", headers: { Origin: "https://app.example" },
        body: JSON.stringify({ endpoint: "https://127.0.0.1/x", headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
      });
      expect(await wake.json()).toEqual({ status: 201 });
      expect(relay.stats()).toMatchObject({ forwarded: 1, tracked: 1 });
      expect(await read()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
