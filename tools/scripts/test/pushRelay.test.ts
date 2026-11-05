import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PUSH_SERVICE_HOSTS } from "../../../packages/core/src/webPush";
import { DEFAULT_LIMITS, PUSH_HOSTS, clientAddress, rateKey, readRelayRequest, startRelay } from "../../../infra/services/push-relay/relay.mjs";

// covers: push.wake.send

const body = Buffer.from("encrypted").toString("base64url");
const request = (patch: Record<string, unknown> = {}) => JSON.stringify({
  endpoint: "https://fcm.googleapis.com/fcm/send/x", headers: { Authorization: "vapid t=a.b.c, k=K", TTL: "3600", Cookie: "no" }, body, ...patch,
});

describe("the push relay (infra/services/push-relay)", () => {
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

  it.each([
    ["a NUL", { TTL: "6\u00000" }, "Bad TTL value"],
    ["a character above U+00FF", { Topic: "Āabc" }, "Bad Topic value"],
    ["a line break", { Urgency: "high\r\nX: 1" }, "Bad Urgency value"],
    ["another control character", { Topic: "a\u0001b" }, "Bad Topic value"],
    ["a DEL", { "content-type": "a\u007fb" }, "Bad Content-Type value"],
  ])("refuses a Web Push header value fetch would not send (%s), naming the header", (_what, header, error) => {
    expect(readRelayRequest(request({ headers: { Authorization: "vapid t=a.b.c, k=K", ...header } })).error).toBe(error);
  });

  it("forwards a header value fetch sends: Latin-1, a tab around it", () => {
    expect(readRelayRequest(request({ headers: { Authorization: "vapid t=a.b.c, k=K", Topic: "é", Urgency: "high\t" } })).headers)
      .toEqual({ Authorization: "vapid t=a.b.c, k=K", Topic: "é", Urgency: "high\t" });
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

  it("counts an IPv4-mapped address as its IPv4 address however it is written", () => {
    expect(rateKey("::ffff:c000:201")).toBe("192.0.2.1");
    expect(rateKey("::ffff:c000:202")).toBe("192.0.2.2");
    expect(rateKey("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateKey("0000:0000:0000:0000:0000:FFFF:C000:0201")).toBe("192.0.2.1");
    expect(rateKey("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(rateKey("::ffff:192.0.2.1%eth0")).toBe("192.0.2.1");
    expect(rateKey("[::ffff:c000:201]:443")).toBe("192.0.2.1");
    expect(rateKey("::ffff:0:c000:201")).toBe("0:0:0:0::/64");
    expect(rateKey("1::2:3:4:5:1.2.3.4")).toBe("1:0:2:3::/64");
  });

  it("counts an address a proxy wrote with its port, or in brackets, as the address alone", () => {
    expect(rateKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(rateKey("203.0.113.7:51235")).toBe("203.0.113.7");
    expect(rateKey("[2001:db8:1:2::1]:443")).toBe("2001:db8:1:2::/64");
    expect(rateKey("[2001:db8:1:2::1]")).toBe("2001:db8:1:2::/64");
    expect(rateKey("[::ffff:203.0.113.7]:51234")).toBe("203.0.113.7");
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

  it("lets a browser in whose origin was set with a trailing slash, in upper case or with its default port", async () => {
    const relay = await startRelay({ origins: ["HTTPS://App.Ghostly.Tools:443/"] });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://app.ghostly.tools" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.ghostly.tools");
    // Past the origin check: refused for its endpoint, not for where it came from.
    expect((await fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools" }, body: request({ endpoint: "https://example.com/" }) })).status).toBe(400);
  });

  it("answers a refused origin with a 403 the page can read, and names that origin on the refusal's first line", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ origins: ["https://app.ghostly.tools"], log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    for (let n = 0; n < 3; n++) {
      // The app posts JSON, so the browser sends the POST only after a preflight it may read.
      const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://app.ghostly.tools.example" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.ghostly.tools.example");
      expect(preflight.headers.get("access-control-allow-headers")).toBe("Content-Type");
      const refused = await fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools.example", "Content-Type": "application/json" }, body: request() });
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBe("https://app.ghostly.tools.example");
      expect(await refused.json()).toEqual({ error: "Origin not allowed" });
    }
    expect((await fetch(url, { method: "POST", body: request() })).status).toBe(403);
    // One kind among the refusals: the first line names the origin, the rest of the minute is a count (the preflights
    // were answered, so three POSTs and one without an Origin are the four refusals).
    expect(lines).toEqual(['refused origin "https://app.ghostly.tools.example"']);
    expect(await (await fetch(`${url}healthz`)).json()).toMatchObject({ forwarded: 0, refused: 4 });
    await relay.close();
    close = undefined;
    expect(lines).toEqual(['refused origin "https://app.ghostly.tools.example"', "refused origin 3 more"]);
  });

  it("names a request without an Origin as (none), and cuts a long one, quoted, so it cannot break the line", async () => {
    const lines: string[] = [];
    const relay = await startRelay({ origins: ["https://app.ghostly.tools"], log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    expect((await fetch(url, { method: "POST", body: request() })).status).toBe(403);
    await relay.close();
    const again = await startRelay({ origins: ["https://app.ghostly.tools"], log: (...words: unknown[]) => { lines.push(words.join(" ")); } });
    close = again.close;
    expect((await fetch(`http://127.0.0.1:${again.port}/`, { method: "POST", headers: { Origin: `https://${"a".repeat(300)}.example` }, body: request() })).status).toBe(403);
    expect(lines).toEqual(["refused origin (none)", `refused origin ${JSON.stringify(`https://${"a".repeat(300)}.example`.slice(0, 200))}`]);
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

  it("limits a client behind a proxy that writes its port, though each request comes from a new one", async () => {
    const relay = await startRelay({ limits: { perMinute: 3 }, proxies: 1 });
    close = relay.close;
    const url = `http://127.0.0.1:${relay.port}/`;
    const post = (xff: string) => fetch(url, { method: "POST", headers: { Origin: "https://app.ghostly.tools", "X-Forwarded-For": xff }, body: request({ endpoint: "https://example.com/" }) });
    const statuses = [];
    for (let n = 1; n <= 4; n++) statuses.push((await post(`203.0.113.7:5000${n}`)).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
    expect((await post("[2001:db8:1:2::1]:443")).status).toBe(400);
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
