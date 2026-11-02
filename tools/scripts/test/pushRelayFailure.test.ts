import { afterEach, describe, expect, it } from "vitest";
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
