import { afterEach, describe, expect, it } from "vitest";
import { startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's health check (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("answers GET /healthz with 200 and its counts, without an Origin, and refuses any other GET", async () => {
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
    expect(await fresh.json()).toEqual({ ok: true, forwarded: 0, failed: 0, refused: 0, tracked: 0 });
    expect((await post("https://127.0.0.1/x")).status).toBe(502);
    expect((await post("https://example.com/x")).status).toBe(400);
    expect((await fetch(`${url}/`)).status).toBe(405);
    expect((await fetch(`${url}/status`)).status).toBe(405);
    expect(await (await fetch(`${url}/healthz?probe=1`)).json()).toEqual({ ok: true, forwarded: 0, failed: 1, refused: 3, tracked: 1 });
  });
});
