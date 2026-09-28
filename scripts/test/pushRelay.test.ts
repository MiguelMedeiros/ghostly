import { afterEach, describe, expect, it } from "vitest";
import { readRelayRequest, startRelay } from "../../native-transports/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");
const request = (patch: Record<string, unknown> = {}) => JSON.stringify({
  endpoint: "https://fcm.googleapis.com/fcm/send/x", headers: { Authorization: "vapid t=a.b.c, k=K", TTL: "3600", Cookie: "no", Urgency: "high\r\nX: 1" }, body, ...patch,
});

describe("the push relay (native-transports/push-relay)", () => {
  it("forwards only to push services, only the Web Push headers, and the body as bytes", () => {
    const read = readRelayRequest(request());
    expect(read.endpoint).toBe("https://fcm.googleapis.com/fcm/send/x");
    expect(read.headers).toEqual({ Authorization: "vapid t=a.b.c, k=K", TTL: "3600" });
    expect(Buffer.from(read.body).toString()).toBe("encrypted");
    for (const endpoint of ["https://web.push.apple.com/QAB", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/x"]) {
      expect(readRelayRequest(request({ endpoint })).error).toBeUndefined();
    }
  });

  it.each([
    ["not a push service", { endpoint: "https://example.com/x" }],
    ["plain http", { endpoint: "http://fcm.googleapis.com/x" }],
    ["a look-alike host", { endpoint: "https://fcm.googleapis.com.evil.example/x" }],
    ["credentials", { endpoint: "https://u:p@fcm.googleapis.com/x" }],
    ["a body that is not base64url", { body: "!!!" }],
    ["a body too large", { body: Buffer.alloc(9000).toString("base64url") }],
  ])("refuses %s", (_what, patch) => {
    expect(readRelayRequest(request(patch)).error).toBeTruthy();
  });

  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it("answers CORS for the origins it serves, refuses others, and limits each address", async () => {
    const relay = await startRelay({ origins: ["https://app.ghostly.tools"], limits: { perMinute: 1 } });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://app.ghostly.tools" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.ghostly.tools");
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://evil.example" }, body: request() })).status).toBe(403);
    const bad = await fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request({ endpoint: "https://example.com/" }) });
    expect(bad.status).toBe(400);
    const limited = await fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request({ endpoint: "https://example.com/" }) });
    expect(limited.status).toBe(429);
  });
});
