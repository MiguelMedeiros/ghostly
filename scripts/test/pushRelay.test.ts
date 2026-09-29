import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PUSH_SERVICE_HOSTS } from "../../packages/core/src/webPush";
import { DEFAULT_LIMITS, PUSH_HOSTS, clientAddress, rateKey, readRelayRequest, startRelay } from "../../native-transports/push-relay/relay.mjs";

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

  it("posts to the same push services the apps post to", () => {
    expect(PUSH_HOSTS.map(String)).toEqual(PUSH_SERVICE_HOSTS.map(String));
  });

  it.each([
    ["not a push service", { endpoint: "https://example.com/x" }],
    ["plain http", { endpoint: "http://fcm.googleapis.com/x" }],
    ["a look-alike host", { endpoint: "https://fcm.googleapis.com.evil.example/x" }],
    ["credentials", { endpoint: "https://u:p@fcm.googleapis.com/x" }],
    ["a port of its own", { endpoint: "https://fcm.googleapis.com:8443/x" }],
    ["no VAPID authorization", { headers: { TTL: "60" } }],
    ["an authorization that is not VAPID", { headers: { Authorization: "Bearer x" } }],
    ["a second authorization in another spelling", { headers: { Authorization: "vapid t=a.b.c, k=K", authorization: "Bearer x" } }],
    ["a header named twice", { headers: { Authorization: "vapid t=a.b.c, k=K", TTL: "60", ttl: "60" } }],
    ["a body that is not base64url", { body: "!!!" }],
    ["a body too large", { body: Buffer.alloc(9000).toString("base64url") }],
  ])("refuses %s", (_what, patch) => {
    expect(readRelayRequest(request(patch)).error).toBeTruthy();
  });

  it("counts a request against the socket's address, and X-Forwarded-For only behind configured proxies", () => {
    const req = (xff?: string) => ({ socket: { remoteAddress: "10.0.0.1" }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    expect(clientAddress(req("1.2.3.4"))).toBe("10.0.0.1");
    expect(clientAddress(req("9.9.9.9, 1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientAddress(req("9.9.9.9, 1.2.3.4, 5.6.7.8"), 2)).toBe("1.2.3.4");
    expect(clientAddress(req(), 1)).toBe("10.0.0.1");
  });

  it("counts an IPv6 address by its /64, and an IPv4 one as it is", () => {
    expect(rateKey("2001:db8:1:2:aaaa::1")).toBe(rateKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(rateKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateKey("2001:db8:1:3::1")).not.toBe(rateKey("2001:db8:1:2::1"));
    expect(rateKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey("1.2.3.4")).toBe("1.2.3.4");
    expect(rateKey("::1")).toBe("0:0:0:0::/64");
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

  it("limits each client behind a proxy apart, not the proxy as one", async () => {
    const relay = await startRelay({ limits: { perMinute: 1 }, proxies: 1 });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const post = (xff: string) => fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": xff }, body: request({ endpoint: "https://example.com/" }) });
    expect((await post("1.1.1.1")).status).toBe(400);
    expect((await post("2.2.2.2")).status).toBe(400);
    expect((await post("1.1.1.1")).status).toBe(429);
    expect(relay.tracked()).toBe(2);
  });

  it("a full table forgets the address seen longest ago, not every newcomer", async () => {
    const relay = await startRelay({ limits: { perMinute: 1, tracked: 3 }, proxies: 1 });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const post = (xff: string) => fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": xff }, body: request({ endpoint: "https://example.com/" }) });
    for (const address of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) expect((await post(address)).status).toBe(400);
    // A newcomer still gets in; the table stays at its size.
    expect((await post("4.4.4.4")).status).toBe(400);
    expect(relay.tracked()).toBe(3);
    // The ones kept are still limited; the first one was forgotten.
    expect((await post("4.4.4.4")).status).toBe(429);
    expect((await post("3.3.3.3")).status).toBe(429);
    expect((await post("1.1.1.1")).status).toBe(400);
  });

  it("weighs a request in bytes, not characters", async () => {
    const relay = await startRelay();
    close = relay.close;
    // Fewer characters than the limit, more bytes.
    const heavy = request({ memo: "é".repeat(9000) });
    expect(heavy.length).toBeLessThan(DEFAULT_LIMITS.bodyBytes * 2);
    expect(Buffer.byteLength(heavy)).toBeGreaterThan(DEFAULT_LIMITS.bodyBytes * 2);
    const answer = await fetch(`http://127.0.0.1:${relay.port}/`, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: heavy });
    expect(answer.status).toBe(413);
  });

  it("closes a client that sends its request too slowly", async () => {
    const relay = await startRelay({ limits: { requestMs: 300 } });
    close = relay.close;
    const socket = connect(relay.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("POST / HTTP/1.1\r\nHost: relay\r\nOrigin: https://app.ghostly.tools\r\nContent-Length: 100\r\n\r\n{");
    const started = Date.now();
    await new Promise((resolve) => { socket.once("close", resolve); socket.resume(); });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
