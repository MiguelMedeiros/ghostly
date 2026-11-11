import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ANSWER_BY_MS, CookieJar, openServiceView, serve, serviceLabel } from "../../../../web/src/svc/opener";
import { closeServiceWindows, hostErrorText, serviceFraming, setServiceWindowsCloser } from "../../lib/serviceWindows";
import { loadLocale, translatorFor } from "../../locales";
import { onAppInput } from "../../lib/apps/open";
import { BRIDGE_READY, BRIDGE_REFUSED, HEAD_TIMEOUT_MS, MAX_REQUEST_BYTES, SERVICE_VIEW_ID, closeServiceView, isServiceHostname, parseServicesHost, serviceOrigin, type ServiceReply } from "../../../../web/src/svc/protocol";
import { createHash } from "node:crypto";
import { CHUNK_KIND, CLIPBOARD_GUARD_HASH, CLIPBOARD_GUARD_SCRIPT, GhostlyHttpError, HttpClient, LIMITS, MAX_CHUNK_PAYLOAD_BYTES, VIEWER_GUARD_CSP, VIEWER_GUARD_HASH, VIEWER_GUARD_SCRIPT, VIEWER_SERVICE_CSP, VIEWER_SERVICE_CSP_RELAY_ONLY, decodeChunk, decodeControl, encodeChunk, type ClientRequest, type ClientResponse } from "@ghostly/core";

// covers: services.web-open

/**
 * Opening a contact's shared web app on the web (apps/web/src/svc/opener.ts): the origin it gets, the cookies it keeps,
 * the answer it streams back, and the view it is shown in (the protocol itself: servicesProtocol.test.ts). The browser's own part (the worker under the bridge) is e2e/web/services-web-open.spec.ts.
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const PEER = "o".repeat(52);

describe("what frames a contact's app (serviceFraming)", () => {
  const t = translatorFor("en");

  it("names the contact as this side calls them, else their nickname, else by their key", () => {
    expect(serviceFraming("Demo", { label: "Ana (work)", nick: "Ghostly" }, PEER, t)).toEqual({
      label: "Demo, shared by \u2068Ana (work)\u2069",
      owner: "\u2068Ana (work)\u2069's app, running on their machine. Not Ghostly: never type your recovery words or passwords here.",
    });
    expect(serviceFraming("Demo", { label: " ", nick: "Demo bot" }, PEER, t).label).toBe("Demo, shared by \u2068Demo bot\u2069");
    expect(serviceFraming("Demo", undefined, PEER, t).label).toBe(`Demo, shared by \u2068${t("common.unnamedContact", { key: PEER.slice(0, 6) })}\u2069`);
  });

  it("is said in every language, with the contact in each", async () => {
    for (const language of ["en", "pt", "es", "fr", "it", "zh", "ja", "ar"] as const) {
      await loadLocale(language);
      const said = serviceFraming("Demo", { nick: "Bob" }, PEER, translatorFor(language));
      if (language !== "en") expect(said.owner, language).not.toBe(serviceFraming("Demo", { nick: "Bob" }, PEER, translatorFor("en")).owner);
      expect(said.label, language).toContain("\u2068Bob\u2069");
      expect(said.label, language).toContain("Demo");
      expect(said.owner, language).toContain("\u2068Bob\u2069");
      expect(said.owner, language).toContain("Ghostly");
    }
  });
});

describe("the origin a contact's app runs on", () => {
  it("is one DNS label under the services host, never the app's own host", async () => {
    const label = await serviceLabel("ybndrfg8ejkmcpqx", PEER, "hello");
    expect(label).toMatch(/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/);
    expect(serviceOrigin(host, label)).toBe(`https://${label}.svc.ghostly.example`);
    expect(isServiceHostname(host, `${label}.svc.ghostly.example`)).toBe(true);
    // The services host itself, the app's host, a deeper name and a label of another shape are not one.
    for (const name of ["svc.ghostly.example", "app.ghostly.example", `a.${label}.svc.ghostly.example`, "hello.svc.ghostly.example", `${label}.ghostly.example`]) {
      expect(isServiceHostname(host, name)).toBe(false);
    }
  });

  it("is another for another profile, contact or service: none shares the storage of another", async () => {
    const one = await serviceLabel("ybndrfg8ejkmcpqx", PEER, "hello");
    expect(await serviceLabel("ybndrfg8ejkmcpqx", PEER, "hello")).toBe(one);
    expect(await serviceLabel("ybndrfg8ejkmcpqo", PEER, "hello")).not.toBe(one);
    expect(await serviceLabel("ybndrfg8ejkmcpqx", "y".repeat(52), "hello")).not.toBe(one);
    expect(await serviceLabel("ybndrfg8ejkmcpqx", PEER, "atlas")).not.toBe(one);
  });
});

describe("the cookies one opened app keeps", () => {
  it("are its own Set-Cookies, sent back by name, and gone once expired", () => {
    const jar = new CookieJar();
    expect(jar.header()).toBeNull();
    jar.take("sid=abc; Path=/; HttpOnly; Domain=evil.example");
    jar.take("theme=dark");
    expect(jar.header()).toBe("sid=abc; theme=dark");
    jar.take("theme=; Max-Age=0");
    jar.take("sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(jar.header()).toBeNull();
    jar.take("=nameless");
    expect(jar.header()).toBeNull();
  });
  it("read Max-Age before Expires, and skip a Max-Age that is no number of seconds", () => {
    const jar = new CookieJar();
    const past = new Date(Date.now() - 3_600_000).toUTCString();
    // What Express sends for `maxAge` when the contact's clock is behind this device's.
    jar.take(`sid=abc; Max-Age=3600; Path=/; Expires=${past}; HttpOnly`);
    jar.take("a=2; Max-Age=");
    jar.take("b=3; Max-Age=soon");
    expect(jar.header()).toBe("sid=abc; a=2; b=3");
    jar.take(`sid=; Expires=${new Date(Date.now() + 3_600_000).toUTCString()}; Max-Age=-1`);
    jar.take("a=; Max-Age=60; Max-Age=0");
    expect(jar.header()).toBe("b=3");
  });
  it("hold a bounded number of names", () => {
    const jar = new CookieJar();
    for (let i = 0; i < CookieJar.MAX + 10; i++) jar.take(`c${i}=1`);
    expect(jar.header()!.split("; ")).toHaveLength(CookieJar.MAX);
  });
});

/** A port that records what it is sent, as the worker's end of a request's channel. */
function recorder() {
  const replies: ServiceReply[] = [];
  let closed = false;
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (reply: ServiceReply) => { replies.push(reply); }, close: () => { closed = true; } };
  return { port: port as unknown as MessagePort, replies, closed: () => closed, cancel: () => port.onmessage?.({ data: { type: "cancel" } }) };
}

function answer(status: number, headers: [string, string][], chunks: string[]): ClientResponse {
  return {
    status, headers,
    body: (async function* () { for (const chunk of chunks) yield new TextEncoder().encode(chunk); })(),
    bytes: async () => new Uint8Array(),
  };
}

const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Your contact is offline", retry: "Try again", blocked: "This browser blocks Demo here", unguarded: "This page of Demo cannot be shown here", label: "Demo, shared by Demo bot", owner: "Demo bot's app, running on their machine. Not Ghostly.", hostError: () => null };

describe("one request from the app, over the contact's link", () => {
  it("goes with the page's headers and the app's cookies, and its answer streams back: cookies kept here, never handed to the page", async () => {
    const jar = new CookieJar();
    jar.take("sid=abc");
    const sent: ClientRequest[] = [];
    const { port, replies, closed } = recorder();
    await serve(port, { type: "request", method: "POST", path: "/api", headers: [["content-type", "text/plain"], ["cookie", "forged=1"]], body: new TextEncoder().encode("hi").buffer },
      async (request) => { sent.push(request); return answer(200, [["content-type", "text/plain"], ["set-cookie", "theme=dark; Path=/"], ["x-bad", "a\r\nb"]], ["he", "llo"]); }, jar, words);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/api", headers: [["content-type", "text/plain"], ["cookie", "sid=abc"]] });
    expect(new TextDecoder().decode(sent[0]!.body!)).toBe("hi");
    // A page the clipboard guard cannot go into (no destination said, so taken for one) runs no script.
    expect(replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/plain"], ["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", "script-src 'none'; frame-src 'none'; object-src 'none'"], ["content-security-policy", VIEWER_SERVICE_CSP]] });
    expect(replies.slice(1, 3).map((r) => r.type === "chunk" && new TextDecoder().decode(r.bytes))).toEqual(["he", "llo"]);
    expect(replies[replies.length - 1]).toEqual({ type: "end" });
    expect(jar.header()).toBe("sid=abc; theme=dark");
    expect(closed()).toBe(true);
  });

  it("keeps the app to its own origin while Hide my IP from contacts is on: Ghostly's policy goes after the contact's", async () => {
    // covers: settings.network.relay-only
    const { port, replies } = recorder();
    await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null },
      async () => answer(200, [["content-type", "text/html"], ["content-security-policy", "img-src *"]], ["<img src=\"https://contact.example/p.png\">"]), new CookieJar(), words, undefined, true);
    expect(replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/html"], ["content-security-policy", "img-src *"], ["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", VIEWER_SERVICE_CSP_RELAY_ONLY]] });
    // Off: the viewer policy every Ghostly viewer adds (its own origin to talk to, no plain http), after the contact's
    // and the clipboard guard's.
    const off = recorder();
    await serve(off.port, { type: "request", method: "GET", path: "/", headers: [], body: null },
      async () => answer(200, [["content-type", "text/html"], ["content-security-policy", "img-src *"]], ["<p>hi</p>"]), new CookieJar(), words, undefined, false);
    expect(off.replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/html"], ["content-security-policy", "img-src *"], ["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", VIEWER_SERVICE_CSP]] });
  });

  it("puts the clipboard guard first in each page of an app, and the WebRTC guard after it while Hide my IP from contacts is on", async () => {
    // covers: settings.network.relay-only
    const page = "<!doctype html><title>Atlas</title><script nonce=a>new RTCPeerConnection()</script>";
    const served = async (destination: string | undefined, relayOnly: boolean, type = "text/html") => {
      const { port, replies } = recorder();
      await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null, ...(destination === undefined ? {} : { destination }) },
        async () => answer(200, [["content-type", type], ["content-length", String(page.length)], ["content-security-policy", "script-src 'nonce-a'"]], [page.slice(0, 7), page.slice(7)]), new CookieJar(), words, undefined, relayOnly);
      const head = replies[0] as Extract<ServiceReply, { type: "head" }>;
      const text = replies.filter((r) => r.type === "chunk").map((r) => new TextDecoder().decode((r as { bytes: Uint8Array }).bytes)).join("");
      return { headers: head.headers, text };
    };
    const guarded = await served("iframe", true);
    expect(guarded.text).toBe(`<!doctype html><script>${CLIPBOARD_GUARD_SCRIPT}</script><script>${VIEWER_GUARD_SCRIPT}</script><title>Atlas</title><script nonce=a>new RTCPeerConnection()</script>`);
    // The contact's policy lets it run; its length is not the page's any more.
    expect(guarded.headers).toEqual([
      ["content-type", "text/html"],
      ["content-security-policy", `script-src 'nonce-a' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH}`],
      ["content-security-policy", VIEWER_GUARD_CSP],
      ["content-security-policy", VIEWER_SERVICE_CSP_RELAY_ONLY],
    ]);
    // A page the guard cannot go into runs no script.
    expect((await served("iframe", true, "image/svg+xml")).headers).toContainEqual(["content-security-policy", "script-src 'none'; frame-src 'none'; object-src 'none'"]);
    // What is not a page (a fetch, a script) is the contact's as it was; with it off, a page has the clipboard guard alone.
    expect((await served("", true)).text).toBe(page);
    expect((await served("script", true, "text/javascript")).text).toBe(page);
    const off = await served("iframe", false);
    expect(off.text).toBe(`<!doctype html><script>${CLIPBOARD_GUARD_SCRIPT}</script><title>Atlas</title><script nonce=a>new RTCPeerConnection()</script>`);
    expect(off.headers).toEqual([["content-type", "text/html"], ["content-security-policy", `script-src 'nonce-a' ${CLIPBOARD_GUARD_HASH}`], ["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", VIEWER_SERVICE_CSP]]);
  });

  it("says the contact is not reachable, in the profile's words, when the link is gone; any other failure as failed", async () => {
    for (const [error, status, text] of [[new GhostlyHttpError("offline", "x"), 503, "Not reachable"], [new GhostlyHttpError("timeout", "x"), 503, "Not reachable"], [new Error("boom"), 502, "Failed"]] as const) {
      const { port, replies } = recorder();
      await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null }, async () => { throw error; }, new CookieJar(), words);
      expect(replies).toEqual([{ type: "error", status, text }]);
    }
  });

  it("says the contact's machine answering for their app (`x-ghostly-error`) in the profile's words, from this side", async () => {
    const t = translatorFor("ar");
    const said = { ...words, hostError: (headers: readonly (readonly [string, string])[]) => hostErrorText(headers, "Demo", t) };
    for (const [status, code, english, key] of [
      [502, "unreachable", "The local service is not reachable.", "services.window.notAnswering"],
      [504, "timeout", "The local service did not answer in time.", "services.window.tooSlow"],
      [502, "redirect-blocked", "The service redirected outside of the shared target.", "services.window.elsewhere"],
      [503, "busy", "Too many requests.", "services.window.busy"],
      [404, "unknown-service", "Unknown service.", "services.window.unshared"],
      // A code this build does not know yet: the generic line, never the contact's English.
      [405, "method-not-allowed", "Method not allowed.", "services.window.failed"],
    ] as const) {
      const { port, replies } = recorder();
      await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null },
        async () => answer(status, [["content-type", "text/plain; charset=utf-8"], ["x-ghostly-error", code]], [`${english}\n`]), new CookieJar(), said);
      expect(replies).toEqual([{ type: "error", status, text: t(key, { app: "Demo" }) }]);
      expect(replies[0]!.type === "error" && replies[0]!.text).not.toContain(english);
    }
  });

  it("answers in the profile's words before the services worker would give up with its own English", async () => {
    vi.useFakeTimers();
    try {
      const { port, replies, closed } = recorder();
      let aborted = false;
      const done = serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null }, (request) => new Promise<ClientResponse>((_, reject) => {
        request.signal?.addEventListener("abort", () => { aborted = true; reject(new GhostlyHttpError("aborted", "x")); });
      }), new CookieJar(), words);
      await vi.advanceTimersByTimeAsync(ANSWER_BY_MS - 1);
      expect(replies).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(ANSWER_BY_MS).toBeLessThan(HEAD_TIMEOUT_MS);
      // One answer only: the request's own end (aborted) adds nothing after it.
      expect(replies).toEqual([{ type: "error", status: 504, text: "Too slow" }]);
      expect(aborted).toBe(true);
      expect(closed()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the contact's answer when the page stops reading", async () => {
    const { port, cancel } = recorder();
    let signal: AbortSignal | undefined;
    await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null }, async (request) => {
      signal = request.signal;
      return { status: 200, headers: [], bytes: async () => new Uint8Array(), body: (async function* () { cancel(); yield new Uint8Array(1); yield new Uint8Array(1); })() };
    }, new CookieJar(), words);
    expect(signal?.aborted).toBe(true);
  });

  it("holds a bounded number of the app's requests and their bodies in this page, however many it sends: past it, refused at once", async () => {
    vi.useFakeTimers();
    try {
      // The real link client, on a link where the contact never answers: what goes out is counted.
      let sentOnLink = 0;
      const channel = {
        bufferedAmount: LIMITS.sendHighWaterMark + 1, drained: () => new Promise<void>(() => {}), close() {}, onMessage: null, onClose: null,
        send(data: string | Uint8Array) { if (typeof data === "string" && decodeControl(data)?.t === "req") sentOnLink++; },
      };
      const client = new HttpClient(channel);
      const send = (request: ClientRequest) => client.request("demo", request);
      const jar = new CookieJar();
      // One 8 MiB buffer for every POST, as the app can: what counts is what the page holds for each.
      const body = new ArrayBuffer(MAX_REQUEST_BYTES);
      const requests = Array.from({ length: 40 }, () => {
        const r = recorder();
        let ended = false;
        void serve(r.port, { type: "request", method: "POST", path: "/up", headers: [], body }, send, jar, words).finally(() => { ended = true; });
        return { ...r, ended: () => ended };
      });
      await vi.advanceTimersByTimeAsync(0);
      const held = requests.filter((r) => !r.ended());
      const refused = requests.filter((r) => r.ended());
      expect(held.length * MAX_REQUEST_BYTES, "the bodies this page still holds").toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(refused.length).toBe(40 - held.length);
      for (const r of refused) expect(r.replies).toEqual([{ type: "error", status: 503, text: "Failed" }]);
      // Once those end (here: unanswered in time), the app has its room again.
      await vi.advanceTimersByTimeAsync(ANSWER_BY_MS);
      expect(requests.every((r) => r.ended())).toBe(true);
      const again = recorder();
      void serve(again.port, { type: "request", method: "GET", path: "/", headers: [], body: null }, send, jar, words);
      await vi.advanceTimersByTimeAsync(0);
      expect(again.replies).toEqual([]);
      expect(sentOnLink).toBe(held.length + 1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing on the link for what is not a request, and says it failed at once: the worker would wait for an answer", async () => {
    // A path past what the page takes (a long query), a method it does not read, a full URL: none reaches the contact,
    // and each is answered now, in the profile's words, never left to the worker's English after HEAD_TIMEOUT_MS.
    for (const data of [
      { type: "request", method: "GET", path: `/search?q=${"a".repeat(9000)}`, headers: [], body: null },
      { type: "request", method: "patch", path: "/api", headers: [], body: null },
      { type: "request", method: "GET", path: "https://evil.example/", headers: [], body: null },
      null,
    ]) {
      const { port, replies, closed } = recorder();
      let called = false;
      await serve(port, data, async () => { called = true; return answer(200, [], []); }, new CookieJar(), words);
      expect(called).toBe(false);
      expect(replies).toEqual([{ type: "error", status: 400, text: "Failed" }]);
      expect(closed()).toBe(true);
    }
  });
});

/**
 * A port as the browser's: what is posted reaches the worker by structured clone, and a transferred buffer moves (it
 * reads empty on the page after), so a test sees what the worker gets and what the page copied to send it.
 */
function workerPort() {
  const replies: ServiceReply[] = [];
  const transfers: ArrayBuffer[][] = [];
  let closed = false;
  const port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (reply: ServiceReply, transfer: Transferable[] = []) => {
      transfers.push(transfer as ArrayBuffer[]);
      replies.push(structuredClone(reply, { transfer }));
    },
    close: () => { closed = true; },
  };
  return { port: port as unknown as MessagePort, replies, transfers, closed: () => closed, cancel: () => port.onmessage?.({ data: { type: "cancel" } }) };
}

/** The engine's own client for one contact's link, with the link's side recorded: answers are fed as link frames. */
function linkClient() {
  const sent: (string | Uint8Array)[] = [];
  const client = new HttpClient({ send: (data) => { sent.push(data); }, bufferedAmount: 0, drained: async () => {}, close: () => {}, onMessage: null, onClose: null });
  const controls = () => sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as { t: string; id: number });
  /** One body chunk as it comes off the link: its payload a view into the frame, as `decodeChunk` gives it. */
  const chunk = (id: number, payload: Uint8Array, end: boolean) => client.handleChunk(decodeChunk(encodeChunk({ kind: CHUNK_KIND.responseBody, id, end, payload }))!);
  return { client, controls, chunk };
}

/** Bytes copied by `Uint8Array.prototype.slice` while `run` runs. */
async function bytesSliced(run: () => Promise<void>): Promise<{ calls: number; bytes: number }> {
  const slice = Uint8Array.prototype.slice;
  const counted = { calls: 0, bytes: 0 };
  const spy = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (this: Uint8Array, ...args: [number?, number?]) {
    const copy = slice.apply(this, args);
    counted.calls++;
    counted.bytes += copy.byteLength;
    return copy;
  });
  try { await run(); } finally { spy.mockRestore(); }
  return counted;
}

const sha256 = (parts: Uint8Array[]) => { const hash = createHash("sha256"); for (const part of parts) hash.update(part); return hash.digest("hex"); };

describe("a contact's answer on its way to the services worker", () => {
  it("copies each chunk once: a 10 MB answer costs 10 MB of copies, not 20, and reaches the worker byte for byte", async () => {
    const size = 10_000_000;
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = (i * 31 + (i >>> 11)) & 0xff;
    const link = linkClient();
    const { port, replies, transfers, closed } = workerPort();
    const copied = await bytesSliced(async () => {
      const done = serve(port, { type: "request", method: "GET", path: "/big.bin", headers: [], body: null }, (request) => link.client.request("app", request), new CookieJar(), words);
      await vi.waitFor(() => expect(link.controls().some((f) => f.t === "req")).toBe(true));
      link.client.handleResponse({ t: "res", id: 1, st: 200, h: [["content-type", "application/octet-stream"]], b: true });
      for (let at = 0; at < size; at += MAX_CHUNK_PAYLOAD_BYTES) {
        link.chunk(1, body.subarray(at, Math.min(size, at + MAX_CHUNK_PAYLOAD_BYTES)), at + MAX_CHUNK_PAYLOAD_BYTES >= size);
      }
      await done;
    });
    const chunks = replies.filter((r): r is Extract<ServiceReply, { type: "chunk" }> => r.type === "chunk");
    const links = Math.ceil(size / MAX_CHUNK_PAYLOAD_BYTES);
    expect(chunks).toHaveLength(links);
    expect(replies).toHaveLength(links + 2);
    expect(replies[0]).toMatchObject({ type: "head", status: 200 });
    expect(replies[replies.length - 1]).toEqual({ type: "end" });
    // One copy per chunk, out of the link's frame (`HttpClient`): none more on the page to send it on.
    expect(copied).toEqual({ calls: links, bytes: size });
    // Each chunk's own buffer moved to the worker, exactly its bytes: none left behind on the page.
    for (const [i, transfer] of transfers.slice(1, -1).entries()) {
      expect(transfer).toHaveLength(1);
      expect(transfer[0]!.byteLength, `chunk ${i} left on the page`).toBe(0);
      expect(chunks[i]!.bytes.byteLength).toBe(chunks[i]!.bytes.buffer.byteLength);
    }
    const received = chunks.map((c) => c.bytes);
    expect(received.reduce((n, c) => n + c.byteLength, 0)).toBe(size);
    expect(sha256(received)).toBe(sha256([body]));
    expect(closed()).toBe(true);
  });

  it("copies a chunk that is only part of its buffer, and leaves that buffer whole", async () => {
    const shared = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { port, replies, transfers } = workerPort();
    await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null }, async () => ({
      status: 200, headers: [], bytes: async () => new Uint8Array(),
      body: (async function* () { yield shared.subarray(0, 3); yield shared.subarray(3); })(),
    }), new CookieJar(), words);
    expect(replies.filter((r) => r.type === "chunk").map((r) => r.type === "chunk" && [...r.bytes])).toEqual([[1, 2, 3], [4, 5, 6, 7, 8]]);
    expect(transfers.slice(1, -1).map((t) => t.map((b) => b === shared.buffer))).toEqual([[false], [false]]);
    expect([...shared]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("still stops the contact's answer when the page stops reading partway, sending nothing after", async () => {
    const link = linkClient();
    const { port, replies, cancel, closed } = workerPort();
    const sent = port.postMessage.bind(port);
    let seen = 0;
    port.postMessage = ((reply: ServiceReply, transfer?: Transferable[]) => {
      sent(reply, transfer as Transferable[]);
      if (reply.type === "chunk" && ++seen === 3) cancel();
    }) as typeof port.postMessage;
    const done = serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null }, (request) => link.client.request("app", request), new CookieJar(), words);
    await vi.waitFor(() => expect(link.controls().some((f) => f.t === "req")).toBe(true));
    link.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
    for (let i = 0; i < 10; i++) link.chunk(1, new Uint8Array(1024).fill(i), false);
    await done;
    expect(replies.filter((r) => r.type === "chunk").map((r) => r.type === "chunk" && r.bytes[0])).toEqual([0, 1, 2]);
    expect(replies.map((r) => r.type)).toEqual(["head", "chunk", "chunk", "chunk", "end"]);
    expect(link.controls()).toContainEqual(expect.objectContaining({ t: "rst", id: 1 }));
    expect(closed()).toBe(true);
  });
});

describe("a contact's app shown over the app", () => {
  // happy-dom would load the bridge page from the network: the frame is all these tests look at.
  beforeAll(() => { const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });
  afterEach(() => { setServiceWindowsCloser(null); closeServiceView(); });
  const open = (service: string) => openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service, title: service, send: async () => answer(200, [], []), words });

  it("says so in the person's words while the contact is offline, in place of their last page, and loads the app anew once they are back", async () => {
    let offline = false;
    const listeners = new Set<() => void>();
    const presence = { offline: () => offline, watch: (changed: () => void) => { listeners.add(changed); return () => listeners.delete(changed); } };
    const change = (to: boolean) => { offline = to; for (const l of listeners) l(); };
    await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [], []), words, presence });
    const view = document.getElementById(SERVICE_VIEW_ID)!;
    const notice = view.querySelector<HTMLElement>("[data-testid=service-view-offline]")!;
    const frame = view.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
    expect(notice.hidden).toBe(true);
    const first = frame.src;
    change(true);
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("Your contact is offlineTry again");
    expect(frame.style.display).toBe("none");
    // Try again while still offline: the notice stays.
    view.querySelector<HTMLButtonElement>("[data-testid=service-view-retry]")!.click();
    expect(notice.hidden).toBe(false);
    frame.src = "about:blank";
    change(false);
    expect(notice.hidden).toBe(true);
    expect(frame.style.display).toBe("");
    expect(frame.src, "the app is loaded anew").toBe(first);
    // Closed, it hears nothing more.
    view.querySelector<HTMLButtonElement>("[data-testid=service-view-close]")!.click();
    expect(listeners.size).toBe(0);
  });

  it("counts the person's taps and keys in the app for the lock screen, as the browser's activation says, and only while it is open", async () => {
    // Real input in a frame activates every frame above it, this page too; no script, the contact's included, can.
    const activation = { isActive: false };
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
    let heard = 0;
    const stop = onAppInput(() => { heard += 1; });
    vi.useFakeTimers();
    try {
      await open("demo");
      vi.advanceTimersByTime(10_000);
      expect(heard, "no input, nothing").toBe(0);
      // The contact's page saying so itself counts for nothing.
      const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "activity" }, origin: new URL(frame.src).origin, source: frame.contentWindow }));
      vi.advanceTimersByTime(10_000);
      expect(heard).toBe(0);
      activation.isActive = true;
      vi.advanceTimersByTime(1_000);
      expect(heard).toBeGreaterThan(0);
      activation.isActive = false;
      const before = heard;
      vi.advanceTimersByTime(10_000);
      expect(heard).toBe(before);
      // Closed: the page's own listeners hear its input again, and nothing is counted twice.
      closeServiceView();
      activation.isActive = true;
      vi.advanceTimersByTime(10_000);
      expect(heard).toBe(before);
    } finally {
      vi.useRealTimers();
      stop();
      delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  it("says why in the person's words when the bridge shows no app (the browser refused it its worker), until Try again loads it anew", async () => {
    // Firefox blocking third-party cookies refuses the bridge its services worker: the services host is a site of its own.
    let offline = false;
    const listeners = new Set<() => void>();
    const presence = { offline: () => offline, watch: (changed: () => void) => { listeners.add(changed); return () => listeners.delete(changed); } };
    await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [], []), words, presence });
    const view = document.getElementById(SERVICE_VIEW_ID)!;
    const notice = view.querySelector<HTMLElement>("[data-testid=service-view-offline]")!;
    const frame = view.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
    const first = frame.src;
    const origin = new URL(first).origin;
    const inFrame = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
    const refused = (reason: string, from: { origin: string; source: unknown } = { origin, source: inFrame }) =>
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_REFUSED, reason }, origin: from.origin, source: from.source as Window }));
    // Only the bridge in the view's frame is heard.
    refused("blocked", { origin: "https://other.example", source: inFrame });
    refused("blocked", { origin, source: window });
    expect(notice.hidden).toBe(true);
    refused("blocked");
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("This browser blocks Demo hereTry again");
    expect(frame.style.display).toBe("none");
    // The contact's presence changing leaves it said, and loads nothing.
    frame.src = "about:blank";
    for (const l of listeners) l();
    expect(notice.textContent).toBe("This browser blocks Demo hereTry again");
    // Offline goes first, and back online it is said again.
    offline = true;
    for (const l of listeners) l();
    expect(notice.textContent).toBe("Your contact is offlineTry again");
    offline = false;
    for (const l of listeners) l();
    expect(notice.textContent).toBe("This browser blocks Demo hereTry again");
    expect(frame.src).toBe("about:blank");
    const retry = view.querySelector<HTMLButtonElement>("[data-testid=service-view-retry]")!;
    retry.focus();
    retry.click();
    expect(notice.hidden).toBe(true);
    expect(frame.style.display).toBe("");
    expect(frame.src, "the bridge is loaded anew").toBe(first);
    expect(document.activeElement, "the focus goes to the app, not the page's body").toBe(frame);
    // A page of the app the bridge would not show.
    refused("unguarded");
    expect(notice.textContent).toBe("This page of Demo cannot be shown hereTry again");
  });

  it("opens on the notice when the contact is already offline", async () => {
    await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [], []), words, presence: { offline: () => true, watch: () => () => {} } });
    expect(document.querySelector<HTMLElement>("[data-testid=service-view-offline]")!.hidden).toBe(false);
  });

  it("is one at a time: opening another closes the one before", async () => {
    await open("one");
    await open("two");
    expect(document.querySelectorAll(`#${SERVICE_VIEW_ID}`)).toHaveLength(1);
    expect([...document.getElementById(SERVICE_VIEW_ID)!.querySelectorAll("span")].map((el) => el.textContent)).toContain("two");
  });

  it("says whose app it is and that it is not Ghostly, always on screen, never the contact's name for it alone", async () => {
    // The contact names their app freely: "Ghostly" is as easy as "Demo".
    await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Ghostly", send: async () => answer(200, [], []), words });
    const view = document.getElementById(SERVICE_VIEW_ID)!;
    const owner = view.querySelector<HTMLElement>("[data-testid=service-view-owner]");
    expect(owner?.textContent).toBe(words.owner);
    expect(owner?.hidden).toBe(false);
    expect(owner?.style.display).not.toBe("none");
    // On the bar, next to ✕ and the app's name, not inside the contact's frame.
    expect(owner?.closest("[data-testid=service-view-frame]")).toBeNull();
    expect(owner?.parentElement?.contains(view.querySelector("[data-testid=service-view-close]"))).toBe(false);
    expect(owner?.parentElement?.parentElement?.contains(view.querySelector("[data-testid=service-view-close]"))).toBe(true);
    // A screen reader hears the same: a modal dialog named with the contact, and so is the frame.
    expect(view.getAttribute("role")).toBe("dialog");
    expect(view.getAttribute("aria-modal")).toBe("true");
    expect(view.getAttribute("aria-label")).toBe(words.label);
    expect(view.querySelector("[data-testid=service-view-frame]")?.getAttribute("title")).toBe(words.label);
  });

  it("ends every request of the app still waiting on the contact when it closes, or when its frame loads again: none holds a place on the link", async () => {
    const signals: AbortSignal[] = [];
    const send = (request: ClientRequest) => new Promise<ClientResponse>((_, reject) => {
      signals.push(request.signal!);
      request.signal!.addEventListener("abort", () => reject(new GhostlyHttpError("aborted", "x")));
    });
    await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send, words });
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
    const origin = new URL(frame.src).origin;
    // The bridge in the frame (happy-dom loads none): says it is ready, takes its channel, and asks for what the app's page asks.
    const inFrame = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
    const bridge = async () => {
      inFrame.postMessage.mockClear();
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_READY }, origin, source: inFrame as unknown as Window }));
      const channel = (inFrame.postMessage.mock.calls[0]![2] as MessagePort[])[0]!;
      return (count: number) => {
        for (let i = 0; i < count; i++) channel.postMessage({ type: "request", method: "GET", path: `/poll/${i}`, headers: [], body: null }, [new MessageChannel().port2]);
      };
    };
    const until = (n: number) => vi.waitFor(() => expect(signals).toHaveLength(n));
    (await bridge())(3);
    await until(3);
    (await bridge())(2);
    await until(5);
    expect(signals.map((s) => s.aborted), "the frame loaded again: the old page's requests end").toEqual([true, true, true, false, false]);
    document.querySelector<HTMLButtonElement>("[data-testid=service-view-close]")!.click();
    expect(signals.every((s) => s.aborted), "closed: every request ends").toBe(true);
  });

  it("answers every request of an app with the viewer policy, and the one that keeps it to its own origin while Hide my IP from contacts is on", async () => {
    for (const relayOnly of [true, false]) {
      await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [["content-type", "text/html"]], ["<p>hi</p>"]), words, relayOnly });
      const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      const inFrame = { postMessage: vi.fn() };
      Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_READY }, origin: new URL(frame.src).origin, source: inFrame as unknown as Window }));
      const channel = (inFrame.postMessage.mock.calls[0]![2] as MessagePort[])[0]!;
      const reply = new MessageChannel();
      const head = new Promise<ServiceReply>((resolve) => { reply.port1.onmessage = (event) => resolve(event.data as ServiceReply); });
      channel.postMessage({ type: "request", method: "GET", path: "/", headers: [], body: null }, [reply.port2]);
      const headers = (await head) as Extract<ServiceReply, { type: "head" }>;
      expect(headers.headers.filter(([name]) => name === "content-security-policy"), String(relayOnly)).toEqual(relayOnly ? [["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", VIEWER_SERVICE_CSP_RELAY_ONLY]] : [["content-security-policy", VIEWER_GUARD_CSP], ["content-security-policy", VIEWER_SERVICE_CSP]]);
      // The bridge, on the app's origin, runs the WebRTC guard too while it is on.
      expect(inFrame.postMessage.mock.calls[0]![0], String(relayOnly)).toEqual({ type: "ghostly-svc-port", relayOnly });
      document.querySelector<HTMLButtonElement>("[data-testid=service-view-close]")!.click();
    }
  });

  it("reads the app's name in its own direction: in the Arabic app a Latin name is cut at its end, not its start", async () => {
    document.documentElement.dir = "rtl";
    try {
      await open("A very long name for the demo app shared here");
      const name = [...document.getElementById(SERVICE_VIEW_ID)!.querySelectorAll("span")].find((el) => el.textContent === "A very long name for the demo app shared here");
      expect(name?.getAttribute("dir")).toBe("auto");
    } finally {
      document.documentElement.removeAttribute("dir");
    }
  });

  it("opens no window of its own: one would be a tab on its origin, outliving the view and the lock", async () => {
    await open("one");
    const sandbox = document.querySelector("[data-testid=service-view-frame]")!.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox.filter((flag) => flag.startsWith("allow-popups") || flag.startsWith("allow-top-navigation"))).toEqual([]);
  });

  it("keeps the view's bar on screen, and draws no dialog of the browser's over it: no full screen, no alert or prompt", async () => {
    await open("one");
    const frame = document.querySelector("[data-testid=service-view-frame]")!;
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("sandbox")!.split(" ")).not.toContain("allow-modals");
  });

  it("saves no file by itself: the contact's app starts no download on this device, as on Desktop", async () => {
    await open("one");
    const sandbox = document.querySelector("[data-testid=service-view-frame]")!.getAttribute("sandbox")!.split(" ");
    expect(sandbox.filter((flag) => flag.startsWith("allow-downloads"))).toEqual([]);
  });

  it("closes when the profile locks (the lock screen's closeServiceWindows), as Desktop's windows do", async () => {
    setServiceWindowsCloser(closeServiceView);
    await open("one");
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
    closeServiceWindows();
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  });

  it("writes nothing to the clipboard by itself: no `clipboard-write`, a copy button in the app still copies on a tap", async () => {
    await open("one");
    const allow = document.querySelector("[data-testid=service-view-frame]")!.getAttribute("allow") ?? "";
    expect(allow.split(";").map((feature) => feature.trim())).not.toContain("clipboard-write");
  });

  it("holds the keyboard while open: the app under it is out of reach, and closing gives the focus back to Open", async () => {
    // The app's page, its Open button focused, and a part of it that was already out of reach.
    const app = document.createElement("div");
    const opener = document.createElement("button");
    app.append(opener);
    const hidden = document.createElement("div");
    hidden.setAttribute("inert", "");
    document.body.append(app, hidden);
    try {
      opener.focus();
      await open("one");
      expect(document.activeElement?.getAttribute("data-testid")).toBe("service-view-close");
      // Tab cannot leave the view for the chat hidden under it.
      expect(app.hasAttribute("inert")).toBe(true);
      expect(document.getElementById(SERVICE_VIEW_ID)?.hasAttribute("inert")).toBe(false);

      closeServiceView();
      expect(document.activeElement).toBe(opener);
      expect(app.hasAttribute("inert")).toBe(false);
      expect(hidden.hasAttribute("inert")).toBe(true);
    } finally {
      app.remove();
      hidden.remove();
    }
  });

  describe("and Back (Android's back gesture, the browser's)", () => {
    const CHAT = "#/chat/abc";
    const ROUTER = { usr: null, key: "k1", idx: 3 };
    /** Waits for the history to settle: a traversal answers with a popstate, or nothing if there is none. */
    const settled = () => new Promise<void>((resolve) => { const done = () => { removeEventListener("popstate", done); resolve(); }; addEventListener("popstate", done); setTimeout(done, 200); });
    const back = async () => { const pop = settled(); history.back(); await pop; };
    afterEach(async () => { await settled(); });

    it("closes the view and leaves the chat under it where it was", async () => {
      history.pushState(ROUTER, "", CHAT);
      await open("one");
      await back();
      expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
      expect(location.hash).toBe(CHAT);
      expect(history.state).toEqual(ROUTER);
    });

    it("has nothing of the view to step over once ✕ closed it: the app's next Back is its own", async () => {
      history.pushState(ROUTER, "", CHAT);
      const length = history.length;
      await open("one");
      const pop = settled();
      (document.querySelector('[data-testid="service-view-close"]') as HTMLButtonElement).click();
      await pop;
      expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
      expect(location.hash).toBe(CHAT);
      expect(history.state).toEqual(ROUTER);
      expect(history.length).toBe(length + 1); // the view's entry is only ahead now, as after any Back
    });

    it("leaves no dead step ahead once ✕ closed it: Forward lands back on the chat, and the next Back leaves it", async () => {
      history.pushState({ usr: null, key: "k0", idx: 2 }, "", "#/chats");
      history.pushState(ROUTER, "", CHAT);
      await open("one");
      const pop = settled();
      (document.querySelector('[data-testid="service-view-close"]') as HTMLButtonElement).click();
      await pop;
      // Forward onto the closed view's entry: nothing to show there, so the page is the chat again, unmarked.
      const forward = settled();
      history.forward();
      await forward;
      await settled();
      expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
      expect(history.state).toEqual(ROUTER);
      // The next Back is the app's own: off the chat, not a press spent leaving a dead entry.
      await back();
      expect(location.hash).toBe("#/chats");
    });

    it("is one step for one view, however many were opened in turn", async () => {
      history.pushState(ROUTER, "", CHAT);
      await open("one");
      await open("two");
      await back();
      expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
      expect(history.state).toEqual(ROUTER);
    });
  });
});
