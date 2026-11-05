import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");

describe("the push relay's log of a failed forward (infra/services/push-relay)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("names why the push service did not answer, never the endpoint", async () => {
    const lines: string[] = [];
    // The "push service" is 127.0.0.1:443, where nothing listens.
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const answer = await fetch(`http://127.0.0.1:${relay.port}/`, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools" },
      body: JSON.stringify({ endpoint: "https://127.0.0.1/secret-endpoint", headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
    });
    expect(answer.status).toBe(502);
    expect(lines).toEqual(["failed ECONNREFUSED"]);
  });

  it("refuses a header value fetch would not send with a 400, as a refusal, not a push service that did not answer", async () => {
    const lines: string[] = [];
    // Nothing listens at 127.0.0.1:443: a request that reached fetch would be `failed ECONNREFUSED`.
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const post = (headers: Record<string, string>) => fetch(url, {
      method: "POST", headers: { Origin: "https://app.ghostly.tools" },
      body: JSON.stringify({ endpoint: "https://127.0.0.1/x", headers: { Authorization: "vapid t=a.b.c, k=K", ...headers }, body }),
    });
    const nul = await post({ TTL: "6\u00000" });
    expect(nul.status).toBe(400);
    expect(await nul.json()).toEqual({ error: "Bad TTL value" });
    const wide = await post({ Topic: "Āabc" });
    expect(wide.status).toBe(400);
    expect(await wide.json()).toEqual({ error: "Bad Topic value" });
    // A value fetch takes still goes on to the push service.
    expect((await post({ Urgency: "high\t" })).status).toBe(502);
    expect(lines).toEqual(["refused Bad TTL value", "refused Bad Topic value", "failed ECONNREFUSED"]);
    expect(await (await fetch(`${url}healthz`)).json()).toMatchObject({ forwarded: 0, failed: 1, refused: 2 });
  });

  it("does not count fetch refusing a request before any connection as a push service that did not answer", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ hosts: [/^127\.0\.0\.1$/], log: (...words: unknown[]) => lines.push(words.join(" ")) });
    close = relay.close;
    const real = globalThis.fetch;
    // The relay's own fetch refuses what it was handed, as Node's does a header value it cannot send.
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => (String(input).startsWith("https://127.0.0.1/")
      ? Promise.reject(new TypeError('Headers.append: "x" is an invalid header value.'))
      : real(input, init)));
    try {
      const url = `http://127.0.0.1:${relay.port}/`;
      const answer = await fetch(url, {
        method: "POST", headers: { Origin: "https://app.ghostly.tools" },
        body: JSON.stringify({ endpoint: "https://127.0.0.1/x", headers: { Authorization: "vapid t=a.b.c, k=K" }, body }),
      });
      expect(answer.status).toBe(400);
      expect(lines).toEqual(["refused Not a request fetch can send"]);
      expect(await (await fetch(`${url}healthz`)).json()).toMatchObject({ failed: 0, refused: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["the 10 s timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "timeout"],
    ["a name that does not resolve", new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND fcm.googleapis.com"), { code: "ENOTFOUND" }) }), "ENOTFOUND"],
    ["a certificate", new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }), "CERT_HAS_EXPIRED"],
    ["a redirect", new TypeError("fetch failed", { cause: new Error("unexpected redirect") }), "redirect"],
    ["a code that is not a code", new TypeError("fetch failed", { cause: { code: "https://fcm.googleapis.com/x" } }), "error"],
    ["nothing to go on", new TypeError("fetch failed"), "error"],
  ])("says %s", (_what, error, word) => {
    expect(failure(error)).toBe(word);
  });
});
