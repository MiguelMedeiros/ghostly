import { afterEach, beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { ANSWER_BY_MS, CookieJar, MAX_PENDING_REQUESTS, MAX_WAITING_REQUESTS, openServiceView, serve, serviceLabel } from "../../../../web/src/svc/opener";
import { closeServiceWindows, hostErrorText, serviceFraming, setServiceWindowsCloser } from "../../lib/serviceWindows";
import { loadLocale, translatorFor } from "../../locales";
import { onAppInput } from "../../lib/apps/open";
import { ANSWER_AHEAD_BYTES, BRIDGE_OPEN_LINK, BRIDGE_READY, BRIDGE_REFUSED, BRIDGE_SHOWN, HEAD_TIMEOUT_MS, MAX_REQUEST_BYTES, SERVICE_VIEW_ID, closeServiceView, isServiceHostname, parseServicesHost, serviceOrigin, type ServiceReply, BRIDGE_PAGE, answerStatus, fromView, readRequest, BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PORT, parseAppOrigin, CLEAR_COOKIES } from "../../../../web/src/svc/protocol";
import { createHash } from "node:crypto";
import { CHUNK_KIND, GhostlyHttpError, HttpClient, LIMITS, MAX_CHUNK_PAYLOAD_BYTES, decodeChunk, decodeControl, encodeChunk, type ClientRequest, type ClientResponse } from "@ghostly/core";
import { precacheList } from "../../../../web/src/sw/policy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLEAR_ORIGIN_MS, forgetServices, noteOpened, openedServices, OPENED_KEY, forgetServicesOfChatsGone, forgetServicesOfGone } from "../../../../web/src/svc/forget";
import { clearSite, dropSharedCookies } from "../../../../web/src/svc/clearSite";

// The web build's own (apps/web/src/env.d.ts), for the web host this test loads; stubbed below.
declare global {
  const __APP_VERSION__: string;
  const __APP_BUILD__: string;
}

// covers: services.web-open
// covers: settings.network.relay-only
describe("opening a contact's app", () => {
  /**
   * Opening a contact's shared web app on the web (apps/web/src/svc/opener.ts): the origin it gets, the cookies it keeps,
   * the answer it streams back, and the view it is shown in (the protocol itself: "the services protocol" below). The browser's own part (the worker under the bridge) is e2e/web/services-web-open.spec.ts.
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
    it("go only to the paths each was set for, the longer path first, as a browser sends them", () => {
      const jar = new CookieJar();
      jar.take("sid=root; Path=/", "/login");
      jar.take("sid=admin; Path=/admin", "/admin/login");
      // No path of its own: the directory of the address that set it.
      jar.take("step=2", "/wizard/one?x=1");
      expect(jar.header("/")).toBe("sid=root");
      expect(jar.header("/admin/users")).toBe("sid=admin; sid=root");
      expect(jar.header("/administrator")).toBe("sid=root");
      expect(jar.header("/wizard/two")).toBe("step=2; sid=root");
      // Gone at its own path only: the one at / stays.
      jar.take("sid=; Path=/admin; Max-Age=0", "/admin/logout");
      expect(jar.header("/admin")).toBe("sid=root");
    });
    it("stop going once their Max-Age or Expires has passed, while the app stays open", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
        const jar = new CookieJar();
        jar.take("flash=saved; Max-Age=5");
        jar.take("csrf=t1; Expires=Thu, 12 Nov 2026 12:00:10 GMT");
        jar.take("sid=abc");
        expect(jar.header()).toBe("flash=saved; csrf=t1; sid=abc");
        vi.setSystemTime(new Date("2026-11-12T12:00:06Z"));
        expect(jar.header()).toBe("csrf=t1; sid=abc");
        vi.setSystemTime(new Date("2026-11-12T12:00:11Z"));
        expect(jar.header()).toBe("sid=abc");
      } finally {
        vi.useRealTimers();
      }
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

  const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Your contact is offline", retry: "Try again", blocked: "This browser blocks Demo here", unguarded: "This page of Demo cannot be shown here", label: "Demo, shared by Demo bot", owner: "Demo bot's app, running on their machine. Not Ghostly.", openLink: (site: string) => `Open ${site}`, hostError: () => null };

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
      // A viewer's headers: no cookie, none a header could not carry. The guards and Ghostly's policy are the worker's.
      expect(replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/plain"]] });
      expect(replies.slice(1, 3).map((r) => r.type === "chunk" && new TextDecoder().decode(r.bytes))).toEqual(["he", "llo"]);
      expect(replies[replies.length - 1]).toEqual({ type: "end" });
      expect(jar.header()).toBe("sid=abc; theme=dark");
      expect(closed()).toBe(true);
    });

    it("sends each request the cookies of its own path, and keeps one an answer sets at that answer's path", async () => {
      const jar = new CookieJar();
      jar.take("sid=root; Path=/");
      jar.take("sid=admin; Path=/admin");
      const cookies: (string | undefined)[] = [];
      const send = async (request: ClientRequest) => {
        cookies.push(request.headers?.find(([name]) => name === "cookie")?.[1]);
        return answer(200, request.path.startsWith("/shop/") ? [["set-cookie", "cart=3"]] : [], []);
      };
      for (const path of ["/admin/users?page=2", "/shop/item", "/shop/cart", "/"]) {
        await serve(recorder().port, { type: "request", method: "GET", path, headers: [], body: null }, send, jar, words);
      }
      expect(cookies).toEqual(["sid=admin; sid=root", "sid=root", "cart=3; sid=root", "sid=root"]);
    });

    it("hands the worker the contact's page as it is: the guards and Ghostly's policy are the worker's to add", async () => {
      const page = "<!doctype html><title>Atlas</title><script nonce=a>new RTCPeerConnection()</script>";
      const { port, replies } = recorder();
      await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null, destination: "iframe" },
        async () => answer(200, [["content-type", "text/html"], ["content-security-policy", "script-src 'nonce-a'"]], [page.slice(0, 7), page.slice(7)]), new CookieJar(), words);
      expect(replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/html"], ["content-security-policy", "script-src 'nonce-a'"]] });
      expect(replies.filter((r) => r.type === "chunk").map((r) => new TextDecoder().decode((r as { bytes: Uint8Array }).bytes)).join("")).toBe(page);
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

    it("takes every file of a page that asks for more at once than the page sends together: the rest wait their turn, none refused", async () => {
      // A gallery's images and its modules: Chromium hands the services worker 100 at once (60 images and 40 modules
      // under one page), well past the requests this page has on the link together.
      const jar = new CookieJar();
      const waiting: (() => void)[] = [];
      let live = 0, most = 0, sent = 0;
      const send = async (request: ClientRequest) => {
        sent++;
        most = Math.max(most, ++live);
        await new Promise<void>((resolve) => waiting.push(resolve));
        live--;
        return answer(200, [["content-type", "image/png"]], [request.path]);
      };
      const requests = Array.from({ length: 100 }, (_, i) => {
        const r = recorder();
        const done = serve(r.port, { type: "request", method: "GET", path: `/img/${i}.png`, headers: [], body: null, destination: "image" }, send, jar, words);
        return { ...r, done };
      });
      // One the page let go of while it waited (the image scrolled away) leaves its turn and never reaches the contact.
      await new Promise((resolve) => setTimeout(resolve, 0));
      requests[99]!.cancel();
      while (waiting.length) { waiting.shift()!(); await new Promise((resolve) => setTimeout(resolve, 0)); }
      await Promise.all(requests.map((r) => r.done));
      expect(most).toBeLessThanOrEqual(MAX_PENDING_REQUESTS);
      expect(sent).toBe(99);
      for (const [i, r] of requests.slice(0, 99).entries()) {
        expect(r.replies[0]?.type, `/img/${i}.png`).toBe("head");
        expect(r.replies[r.replies.length - 1]).toEqual({ type: "end" });
      }
      expect(requests[99]!.replies.every((r) => r.type === "error")).toBe(true);
      // Past what may wait in this page too, a request is refused at once, as before.
      const held: (() => void)[] = [];
      const stuck = async () => { await new Promise<void>((resolve) => held.push(resolve)); return answer(200, [], []); };
      const more = Array.from({ length: MAX_PENDING_REQUESTS + MAX_WAITING_REQUESTS + 1 }, () => {
        const r = recorder();
        void serve(r.port, { type: "request", method: "GET", path: "/", headers: [], body: null }, stuck, jar, words);
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(more.filter((r) => r.replies.length).map((r) => r.replies)).toEqual([[{ type: "error", status: 503, text: "Failed" }]]);
      for (const r of more) r.cancel();
      for (const go of held) go();
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

    /** A request the worker says what the frame read of (`flow`), its answer fed off the link by `feed`. */
    async function flowing(reads: boolean) {
      const link = linkClient();
      const { port, replies, cancel } = workerPort();
      const sent = port.postMessage.bind(port);
      let taken = 0;
      port.postMessage = ((reply: ServiceReply, transfer?: Transferable[]) => {
        // Its length before it goes: the send moves its buffer.
        const length = reply.type === "chunk" ? reply.bytes.byteLength : 0;
        sent(reply, transfer as Transferable[]);
        if (reads && reply.type === "chunk") {
          taken += length;
          const bytes = taken;
          setTimeout(() => port.onmessage?.({ data: { type: "read", bytes } } as MessageEvent));
        }
      }) as typeof port.postMessage;
      const done = serve(port, { type: "request", method: "GET", path: "/video.mp4", headers: [], body: null, flow: true }, (request) => link.client.request("app", request), new CookieJar(), words);
      await vi.waitFor(() => expect(link.controls().some((f) => f.t === "req")).toBe(true));
      link.client.handleResponse({ t: "res", id: 1, st: 200, h: [], b: true });
      let fed = 0;
      const feed = (bytes: number, end = false) => {
        for (let left = bytes; left > 0; left -= MAX_CHUNK_PAYLOAD_BYTES) {
          const n = Math.min(MAX_CHUNK_PAYLOAD_BYTES, left);
          fed += n;
          link.chunk(1, new Uint8Array(n), end && left <= MAX_CHUNK_PAYLOAD_BYTES);
        }
        return fed;
      };
      const worker = () => replies.reduce((n, r) => n + (r.type === "chunk" ? r.bytes.byteLength : 0), 0);
      return { link, replies, cancel, done, feed, worker };
    }

    it("sends the worker no more than a MiB past what the app's frame read: an answer it leaves unread stays on the link, which lets it go", async () => {
      const { link, cancel, done, feed, worker } = await flowing(false);
      feed(16 * 1024 * 1024);
      // The opener took the first MiB off the link within the first `unreadStallMs`: the link lets go at the end of the next.
      await vi.waitFor(() => expect(link.controls()).toContainEqual(expect.objectContaining({ t: "rst", id: 1 })), { timeout: 3 * LIMITS.unreadStallMs });
      expect(worker()).toBeGreaterThanOrEqual(ANSWER_AHEAD_BYTES);
      expect(worker()).toBeLessThanOrEqual(ANSWER_AHEAD_BYTES + MAX_CHUNK_PAYLOAD_BYTES);
      cancel();
      await done;
    });

    it("sends the whole answer to a frame that reads it", async () => {
      const { link, replies, done, feed, worker } = await flowing(true);
      const step = 512 * 1024;
      for (let i = 1; i <= 16; i++) {
        const fed = feed(step, i === 16);
        await vi.waitFor(() => expect(worker()).toBe(fed));
      }
      await done;
      expect(worker()).toBe(16 * step);
      expect(replies[replies.length - 1]).toEqual({ type: "end" });
      expect(link.controls()).not.toContainEqual(expect.objectContaining({ t: "rst" }));
    });

    it("sends the whole answer to a frame that reads it, though the link hands it over faster than the frame reads", async () => {
      const { link, replies, done, feed, worker } = await flowing(true);
      feed(16 * 1024 * 1024, true);
      await done;
      expect(worker()).toBe(16 * 1024 * 1024);
      expect(replies[replies.length - 1]).toEqual({ type: "end" });
      expect(link.controls()).not.toContainEqual(expect.objectContaining({ t: "rst" }));
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
      expect(notice.textContent).toBe("Your contact is offlineTry again");
      frame.src = "about:blank";
      change(false);
      expect(notice.hidden).toBe(true);
      expect(frame.style.display).toBe("");
      expect(frame.src, "the app is loaded anew").toBe(first);
      // Closed, it hears nothing more.
      view.querySelector<HTMLButtonElement>("[data-testid=service-view-close]")!.click();
      expect(listeners.size).toBe(0);
    });

    it("asks the engine to reach the contact on Try again while they are offline, says it is trying, then that they are still offline", async () => {
      let offline = true;
      const listeners = new Set<() => void>();
      const dials: { done: () => void; refuse: () => void }[] = [];
      const connect = () => new Promise<void>((resolve, reject) => { dials.push({ done: resolve, refuse: () => reject(new Error("Timed out connecting to the peer")) }); });
      const presence = { offline: () => offline, watch: (changed: () => void) => { listeners.add(changed); return () => listeners.delete(changed); }, connect };
      const change = (to: boolean) => { offline = to; for (const l of listeners) l(); };
      const reaching = "Trying to reach your contact…", stillOffline = "Your contact is still offline";
      await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [], []), words: { ...words, reaching, stillOffline }, presence });
      const view = document.getElementById(SERVICE_VIEW_ID)!;
      const notice = view.querySelector<HTMLElement>("[data-testid=service-view-offline]")!;
      const frame = view.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      const retry = view.querySelector<HTMLButtonElement>("[data-testid=service-view-retry]")!;
      const said = () => notice.querySelector("p")!.textContent;
      expect(said()).toBe("Your contact is offline");
      const first = frame.src;
      retry.focus();
      retry.click();
      expect(dials, "the engine is asked to reach them").toHaveLength(1);
      expect(said()).toBe(reaching);
      expect(notice.getAttribute("aria-busy")).toBe("true");
      // Kept in reach of the focus, not disabled under it; a second press while it tries asks nothing more.
      expect(retry.disabled).toBe(false);
      expect(retry.getAttribute("aria-disabled")).toBe("true");
      retry.click();
      expect(dials).toHaveLength(1);
      // Something else the engine says meanwhile (the contact still offline) keeps it trying.
      change(true);
      expect(said()).toBe(reaching);
      dials[0]!.refuse();
      await vi.waitFor(() => expect(said()).toBe(stillOffline));
      expect(notice.hasAttribute("aria-busy")).toBe(false);
      expect(retry.hasAttribute("aria-disabled")).toBe(false);
      expect(document.activeElement).toBe(retry);
      // Tried again, and the contact's app answers: the app, loaded anew.
      retry.click();
      expect(dials).toHaveLength(2);
      expect(said()).toBe(reaching);
      frame.src = "about:blank";
      change(false);
      expect(notice.hidden).toBe(true);
      expect(frame.src).toBe(first);
      dials[1]!.done();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(notice.hidden).toBe(true);
      // Offline again later: said as at first, not as after the last Try again.
      change(true);
      expect(said()).toBe("Your contact is offline");
      closeServiceView();
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

    it("says the app is opening, over its frame, until a page of it has loaded, and again once Try again loads it anew", async () => {
      // Until then the frame shows only the bridge's empty white page, for as long as the contact takes to answer.
      let offline = false;
      const listeners = new Set<() => void>();
      const presence = { offline: () => offline, watch: (changed: () => void) => { listeners.add(changed); return () => listeners.delete(changed); } };
      const change = (to: boolean) => { offline = to; for (const l of listeners) l(); };
      const loading = "Opening Demo on your contact's machine…";
      await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => answer(200, [], []), words: { ...words, loading }, presence });
      const view = document.getElementById(SERVICE_VIEW_ID)!;
      const notice = view.querySelector<HTMLElement>("[data-testid=service-view-offline]")!;
      const frame = view.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      const retry = view.querySelector<HTMLButtonElement>("[data-testid=service-view-retry]")!;
      const close = view.querySelector<HTMLButtonElement>("[data-testid=service-view-close]")!;
      const first = frame.src;
      const origin = new URL(first).origin;
      const inFrame = { postMessage: vi.fn() };
      Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
      const shown = (from: { origin: string; source: unknown } = { origin, source: inFrame }) =>
        dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_SHOWN }, origin: from.origin, source: from.source as Window }));
      const loadingSaid = () => {
        expect(notice.hidden).toBe(false);
        expect(notice.getAttribute("role")).toBe("status");
        expect(notice.querySelector("p")!.textContent).toBe(loading);
        expect(notice.getAttribute("aria-busy")).toBe("true");
        expect(retry.hidden, "nothing to try again").toBe(true);
        // Kept in its place and size under the notice: the app's page lays itself out for the screen it opens on.
        expect(frame.style.display).toBe("");
        expect(frame.style.visibility).toBe("hidden");
      };
      loadingSaid();
      expect(document.activeElement).toBe(close);
      // Only the bridge in the view's frame is heard.
      shown({ origin: "https://other.example", source: inFrame });
      shown({ origin, source: window });
      loadingSaid();
      shown();
      expect(notice.hidden).toBe(true);
      expect(notice.hasAttribute("aria-busy")).toBe(false);
      expect(frame.style.visibility).toBe("");
      expect(frame.src, "the page that loaded stays").toBe(first);
      // Its next pages say nothing more.
      shown();
      expect(notice.hidden).toBe(true);
      // Offline: Try again is back, and once they are back the app is loaded anew, said as opening until it is there.
      change(true);
      expect(retry.hidden).toBe(false);
      expect(notice.hasAttribute("aria-busy")).toBe(false);
      retry.focus();
      frame.src = "about:blank";
      change(false);
      loadingSaid();
      expect(frame.src, "the app is loaded anew").toBe(first);
      expect(document.activeElement, "not dropped to the page's body with the hidden Try again").toBe(close);
      shown();
      expect(notice.hidden).toBe(true);
      expect(document.activeElement, "Try again had it: the focus goes to the app").toBe(frame);
      closeServiceView();
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

    it("is one at a time when two opens overlap (Open tapped twice before the first is drawn): the last one wins", async () => {
      await Promise.all([open("one"), open("two")]);
      const views = document.querySelectorAll(`#${SERVICE_VIEW_ID}`);
      expect(views).toHaveLength(1);
      expect([...views[0]!.querySelectorAll("span")].map((el) => el.textContent)).toContain("two");
      expect(views[0]!.hasAttribute("inert")).toBe(false);
      // One close leaves nothing drawn and the app's page in reach again.
      closeServiceView();
      expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
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

    it("answers every request of an app, and tells the bridge whether Hide my IP from contacts is on: the worker it registers guards by it", async () => {
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
        expect(headers, String(relayOnly)).toEqual({ type: "head", status: 200, headers: [["content-type", "text/html"]] });
        // The bridge, on the app's origin, runs the WebRTC guard too while it is on, and registers the worker for it.
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

    it("opens a link the app opens in a new window in a new tab of its own, on the person's tap, as Desktop sends it to the browser: never a local one, nor an app's or Ghostly's own", async () => {
      // The view's sandbox drops the app's own new windows with no word: the bridge hands each one here.
      const activation = { isActive: true };
      Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      vi.useFakeTimers();
      try {
        await open("demo");
        // Past the tap on Open, which activates this page too (the next case).
        vi.advanceTimersByTime(5_100);
        const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
        const origin = new URL(frame.src).origin;
        const inFrame = { postMessage: vi.fn() };
        Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
        const asks = (url: unknown, from: { origin: string; source: unknown } = { origin, source: inFrame }) => {
          dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url }, origin: from.origin, source: from.source as Window }));
          vi.advanceTimersByTime(2_000);
        };
        asks("https://docs.example/guide?a=1#top");
        expect(opened).toHaveBeenCalledTimes(1);
        expect(opened).toHaveBeenLastCalledWith("https://docs.example/guide?a=1#top", "_blank", "noopener,noreferrer");
        // Only the bridge in the view's frame is heard.
        asks("https://docs.example/", { origin: "https://other.example", source: inFrame });
        asks("https://docs.example/", { origin, source: window });
        // Nothing but a plain web link to another public site: none on this machine or the local network, none on an
        // app's origin (a tab of its own there would outlive the view), none on Ghostly's own.
        for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "http://localhost:8080/", "http://192.168.1.1/", "http://[::1]/", "http://router/", "http://nas.local/",
          `${origin}/popup`, "https://svc.ghostly.example/", `${location.origin}/`, `https://docs.example/${"a".repeat(4096)}`, 42, null]) asks(url);
        expect(opened).toHaveBeenCalledTimes(1);
        // Never one the app opens by itself: only within the person's own tap in it (it activates this page; no script can).
        activation.isActive = false;
        asks("https://docs.example/later");
        expect(opened).toHaveBeenCalledTimes(1);
        activation.isActive = true;
        // One every 2 s at most, and 20 in a view's life, as on Desktop: an app opening tabs on every tap stops there.
        dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url: "https://docs.example/1" }, origin, source: inFrame as unknown as Window }));
        dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url: "https://docs.example/2" }, origin, source: inFrame as unknown as Window }));
        expect(opened).toHaveBeenCalledTimes(2);
        for (let i = 0; i < 30; i++) asks(`https://docs.example/${i}`);
        expect(opened).toHaveBeenCalledTimes(20);
      } finally {
        vi.useRealTimers();
        opened.mockRestore();
        delete (navigator as { userActivation?: unknown }).userActivation;
      }
    });

    it("opens no link the app asks for while the tap on Open, or one on Ghostly's page, still activates it: the app's page posts as the bridge, past its check", async () => {
      // The bridge is on the app's origin: the contact's page runs a script of its own in it and asks as the bridge does,
      // right after Open, while that tap still activates this page. Only a tap in the app, after the last one here, counts.
      const activation = { isActive: true };
      Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      vi.useFakeTimers();
      try {
        await open("demo");
        const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
        const origin = new URL(frame.src).origin;
        const inFrame = { postMessage: vi.fn() };
        Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
        const asks = (url: string) => dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url }, origin, source: inFrame as unknown as Window }));
        asks("https://phish.example/on-open");
        vi.advanceTimersByTime(4_900);
        asks("https://phish.example/still-on-open");
        expect(opened).not.toHaveBeenCalled();
        // Past the tap on Open, a tap in the app (it activates this page again) opens one.
        vi.advanceTimersByTime(200);
        asks("https://docs.example/tapped");
        expect(opened).toHaveBeenCalledTimes(1);
        // A tap or a key on Ghostly's page (the view's bar) activates it too: not a tap in the app.
        vi.advanceTimersByTime(3_000);
        document.querySelector("[data-testid=service-view-owner]")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        asks("https://phish.example/on-bar");
        vi.advanceTimersByTime(3_000);
        dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        asks("https://phish.example/on-key");
        expect(opened).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_100);
        asks("https://docs.example/tapped-again");
        expect(opened).toHaveBeenCalledTimes(2);
        expect(opened.mock.calls.map(([url]) => url)).toEqual(["https://docs.example/tapped", "https://docs.example/tapped-again"]);
      } finally {
        vi.useRealTimers();
        opened.mockRestore();
        delete (navigator as { userActivation?: unknown }).userActivation;
      }
    });

    it("offers a link it held back on a button in the view's bar, so the keyboard's Enter on the app's link right after the Tab into it is not lost: only a tap there opens it", async () => {
      // The Tab from ✕ into the app is a key on Ghostly's page: Enter on the app's first link comes within its 5 s.
      const activation = { isActive: true };
      Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      vi.useFakeTimers();
      try {
        await open("demo");
        const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
        const origin = new URL(frame.src).origin;
        const inFrame = { postMessage: vi.fn() };
        Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
        const asks = (url: string) => dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url }, origin, source: inFrame as unknown as Window }));
        const offer = document.querySelector<HTMLButtonElement>("[data-testid=service-view-link]")!;
        expect(offer.hidden).toBe(true);
        vi.advanceTimersByTime(6_000);
        dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        vi.advanceTimersByTime(800);
        asks("https://docs.example/guide");
        expect(opened).not.toHaveBeenCalled();
        // Said, in the bar's live region, with the link's site: the app's next ask takes its place.
        asks("https://xn--80ak6aa92e.com/other");
        expect(offer.hidden).toBe(false);
        expect(offer.closest("[role=status]")).not.toBeNull();
        expect(offer.textContent).toBe("Open ⁨xn--80ak6aa92e.com⁩");
        asks("https://docs.example/guide");
        expect(offer.textContent).toBe("Open ⁨docs.example⁩");
        // Nothing held for a link the app asks for by itself, nor for one that is never opened outside.
        activation.isActive = false;
        asks("https://phish.example/by-itself");
        activation.isActive = true;
        asks("http://localhost:8080/");
        expect(offer.textContent).toBe("Open ⁨docs.example⁩");
        expect(opened).not.toHaveBeenCalled();
        // The person's tap on Ghostly's own button opens it, once.
        offer.click();
        expect(opened).toHaveBeenCalledTimes(1);
        expect(opened).toHaveBeenLastCalledWith("https://docs.example/guide", "_blank", "noopener,noreferrer");
        expect(offer.hidden).toBe(true);
        offer.click();
        expect(opened).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        opened.mockRestore();
        delete (navigator as { userActivation?: unknown }).userActivation;
      }
    });

    it("cuts a long site on the offer at its start, as an address bar does: on a phone the end of its name, the part that says whose it is, stays on screen", async () => {
      const activation = { isActive: true };
      Object.defineProperty(navigator, "userActivation", { configurable: true, value: activation });
      try {
        await open("demo");
        const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
        const origin = new URL(frame.src).origin;
        const inFrame = { postMessage: vi.fn() };
        Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
        dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_OPEN_LINK, url: "https://accounts.google.com.sign-in-verify.example.net/login" }, origin, source: inFrame as unknown as Window }));
        const offer = document.querySelector<HTMLButtonElement>("[data-testid=service-view-link]")!;
        expect(offer.textContent).toBe("Open ⁨accounts.google.com.sign-in-verify.example.net⁩");
        // The words around the site never shrink; the site alone does, from its start (an end-to-start box for a
        // start-to-end name: the ellipsis falls on its left, before "accounts", never on "example.net").
        const site = offer.querySelector<HTMLElement>("[data-testid=service-view-link-site]")!;
        expect(site.textContent).toBe("⁨accounts.google.com.sign-in-verify.example.net⁩");
        expect(site.style.direction).toBe("rtl");
        expect(site.style.textOverflow).toBe("ellipsis");
        expect(parseFloat(site.style.minWidth)).toBe(0);
        expect(offer.style.overflow).not.toBe("hidden");
      } finally {
        delete (navigator as { userActivation?: unknown }).userActivation;
      }
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
});

// covers: services.web-open
describe("the services protocol", () => {
  /**
   * Where a contact's shared web app runs on the web (apps/web/src/svc/protocol.ts): the services host a build is given,
   * the names under it, and what the app's page takes from the bridge. The browser's own part is
   * e2e/web/services-web-open.spec.ts.
   */
  const host = parseServicesHost("https://*.svc.ghostly.example")!;
  const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";

  describe("the services host", () => {
    it("takes only a wildcard host: HTTPS, or plain HTTP on this machine for tests", () => {
      expect(parseServicesHost("https://*.svc.example")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
      expect(parseServicesHost("http://*.localhost:4173")).toEqual({ protocol: "http:", suffix: "localhost", port: "4173" });
      for (const bad of [undefined, "", "https://svc.example", "http://*.svc.example", "https://*.svc.example/path", "https://*.*.example", "javascript:*.x"]) {
        expect(parseServicesHost(bad)).toBeNull();
      }
      expect(BRIDGE_PAGE.startsWith("/_ghostly-svc/")).toBe(true);
    });

    it("names one label under it, never the app's own host nor a deeper or other name", () => {
      expect(serviceOrigin(host, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example`);
      expect(serviceOrigin(parseServicesHost("http://*.localhost:4173")!, LABEL)).toBe(`http://${LABEL}.localhost:4173`);
      expect(isServiceHostname(host, `${LABEL}.svc.ghostly.example`)).toBe(true);
      for (const name of ["svc.ghostly.example", "app.ghostly.example", `a.${LABEL}.svc.ghostly.example`, "hello.svc.ghostly.example", `${LABEL}.ghostly.example`, `${LABEL.slice(1)}.svc.ghostly.example`]) {
        expect(isServiceHostname(host, name)).toBe(false);
      }
    });

    it("keeps the bridge's files out of the app's own cache", () => {
      expect(precacheList(["ghostly-services-sw.js", "_ghostly-svc/bridge.html", "_ghostly-svc/bridge.js", "index.html", "assets/a.js"])).toEqual(["/", "/assets/a.js"]);
    });
  });

  describe("who the worker passes on to the contact", () => {
    const get = { mode: "cors", destination: "" };
    it("the app framed under the bridge, its frames and its workers", () => {
      expect(fromView({ mode: "navigate", destination: "iframe" })).toBe(true);
      expect(fromView(get, { type: "window", frameType: "nested" })).toBe(true);
      expect(fromView(get, { type: "worker" })).toBe(true);
    });

    it("never a tab or a window on the app's origin: one it opened, or one another site opened, outlives the view", () => {
      expect(fromView({ mode: "navigate", destination: "document" })).toBe(false);
      for (const frameType of ["auxiliary", "top-level", "none", undefined]) expect(fromView(get, { type: "window", frameType })).toBe(false);
    });
  });

  describe("what the app's page takes from the bridge", () => {
    const good = { type: "request", method: "POST", path: "/api?x=1", headers: [["content-type", "application/json"]], body: new ArrayBuffer(2) };
    it("a request with a path on the app's origin, its headers and a body within the link's limit", () => {
      expect(readRequest(good)).toMatchObject({ method: "POST", path: "/api?x=1" });
      expect(readRequest({ ...good, body: null, method: "GET" })).toMatchObject({ method: "GET", body: null });
    });
    it("nothing else: another URL, a bad method, too many headers, a body too large", () => {
      for (const bad of [null, "x", { ...good, type: "head" }, { ...good, path: "https://evil.example/" }, { ...good, path: "//evil.example/" }, { ...good, method: "get" },
        { ...good, method: "GET\r\nX: 1" }, { ...good, headers: [["a"]] }, { ...good, headers: Array.from({ length: 129 }, () => ["a", "b"]) },
        { ...good, body: new ArrayBuffer(MAX_REQUEST_BYTES + 1) }, { ...good, body: "text" }]) {
        expect(readRequest(bad)).toBeNull();
      }
    });
    it("answers with the contact's status when a Response can carry it", () => {
      expect(answerStatus(200)).toBe(200);
      expect(answerStatus(404)).toBe(404);
      expect(answerStatus(101)).toBe(502);
      expect(answerStatus(0)).toBe(502);
    });
  });
});

// covers: services.web-open
describe("a services host given with a port", () => {
  /**
   * A services host (or the app's origin) given to the build with its scheme's own port (`https://*.svc.example:443`):
   * the browser writes the origin without it, so every origin the app names from the setting must too, or no message
   * from the bridge ever matches it (apps/web/src/svc/protocol.ts).
   */
  const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";
  const PEER = "o".repeat(52);
  const host = parseServicesHost("https://*.svc.ghostly.example:443")!;

  beforeAll(() => {
    // happy-dom would load the bridge page from the network: the frame and its messages are all these tests look at.
    const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });

  it("names origins as the browser writes them: the scheme's own port dropped, any other kept", () => {
    expect(parseServicesHost("https://*.svc.example:443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("http://*.localhost:80")).toEqual({ protocol: "http:", suffix: "localhost", port: "" });
    expect(parseServicesHost("https://*.svc.example:8443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "8443" });
    expect(parseServicesHost("https://*.svc.example:80")).toEqual({ protocol: "https:", suffix: "svc.example", port: "80" });
    expect(parseServicesHost("http://*.localhost:443")).toEqual({ protocol: "http:", suffix: "localhost", port: "443" });
    expect(parseServicesHost("https://*.svc.example")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("https://*.svc.example:0443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("https://*.svc.example:99999"), "no port at all").toBeNull();
    expect(serviceOrigin(host, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example`);
    expect(serviceOrigin(parseServicesHost("https://*.svc.ghostly.example:8443")!, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example:8443`);
    expect(serviceOrigin(parseServicesHost("http://*.localhost:80")!, LABEL)).toBe(`http://${LABEL}.localhost`);
  });

  it("takes the app's own origin in the browser's form too, the one the bridge compares each message with", () => {
    expect(parseAppOrigin("https://app.example:443")).toBe("https://app.example");
    expect(parseAppOrigin("http://localhost:80")).toBe("http://localhost");
    expect(parseAppOrigin("https://app.example:8443")).toBe("https://app.example:8443");
    expect(parseAppOrigin("http://localhost:4173")).toBe("http://localhost:4173");
    expect(parseAppOrigin("https://app.example")).toBe("https://app.example");
    for (const bad of [undefined, "", "https://app.example/", "https://app.example/path", "javascript:alert(1)", "https://app.example:99999"]) {
      expect(parseAppOrigin(bad), String(bad)).toBeNull();
    }
    // The build hands the bridge that form, not the setting as written.
    const svcBuild = readFileSync(join(import.meta.dirname, "../../../../web/svcBuild.ts"), "utf8");
    expect(svcBuild).toContain("parseAppOrigin(appOrigin)");
    expect(svcBuild).toContain("__SERVICES_APP_ORIGIN__: JSON.stringify(origin)");
  });

  it("hands the bridge its port when it says it loaded, from the origin the browser gives it", async () => {
    const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Your contact is offline", retry: "Try again", blocked: "", unguarded: "", label: "Demo, shared by Demo bot", owner: "Demo bot's app, running on their machine. Not Ghostly.", openLink: (site: string) => `Open ${site}`, hostError: () => null };
    try {
      await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => { throw new Error("not asked"); }, words });
      const origin = `https://${await serviceLabel("ybndrfg8ejkmcpqx", PEER, "demo")}.svc.ghostly.example`;
      const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      const inFrame = { postMessage: vi.fn() };
      Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_READY }, origin, source: inFrame as unknown as Window }));
      expect(inFrame.postMessage).toHaveBeenCalledTimes(1);
      expect(inFrame.postMessage.mock.calls[0]![0]).toMatchObject({ type: BRIDGE_PORT });
      expect(inFrame.postMessage.mock.calls[0]![1]).toBe(origin);
    } finally {
      closeServiceView();
    }
  });

  describe("clearing an opened app's origin", () => {
    afterEach(() => localStorage.clear());

    it("is done by the bridge on it, from the origin the browser gives it", async () => {
      noteOpened({ profile: "", tag: "chat-a", label: LABEL });
      const origin = `https://${LABEL}.svc.ghostly.example`;
      const asked: string[] = [];
      // Plays the bridge on the frame's origin as the browser names it: ready, and cleared when asked.
      const observer = new MutationObserver(() => {
        for (const frame of document.querySelectorAll("iframe")) {
          if (frame.dataset.played) continue;
          frame.dataset.played = "1";
          const win = {
            postMessage: (data: { type?: string }, target: string) => {
              if (data?.type !== BRIDGE_CLEAR) return;
              asked.push(target);
              queueMicrotask(() => say(BRIDGE_CLEARED));
            },
          };
          Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
          const say = (type: string) => dispatchEvent(new MessageEvent("message", { data: { type }, origin, source: win as unknown as Window }));
          queueMicrotask(() => say(BRIDGE_READY));
        }
      });
      observer.observe(document.body, { childList: true });
      try {
        await forgetServices(host, { tag: "chat-a" });
      } finally { observer.disconnect(); }
      expect(asked).toEqual([origin]);
      expect(openedServices(), "cleared, so off the list").toEqual([]);
    }, CLEAR_ORIGIN_MS + 5_000);
  });
});

// covers: services.web-open
describe("forgetting the contacts' apps", () => {
  /**
   * What a contact's app kept on its own origin on the web (apps/web/src/svc/forget.ts, clearSite.ts) goes with the chat,
   * the profile's data or the profile: the app notes each origin it opens, and has the bridge on it clear it. The browser's
   * own part (the storage as Chromium keeps it) is e2e/web/services-web-forget.spec.ts.
   */
  const host = parseServicesHost("https://*.svc.ghostly.example")!;
  const label = (c: string) => c.repeat(32);

  beforeAll(() => {
    // happy-dom would load the bridge page from the network: the frame and its messages are all these tests look at.
    const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
    if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  });

  /** Plays the bridge on every origin a frame loads, but `silent` ones: says it is ready, and clears when asked. */
  function bridges(silent: string[] = []) {
    const asked: string[] = [];
    const observer = new MutationObserver(() => {
      for (const frame of document.querySelectorAll("iframe")) {
        if (frame.dataset.played) continue;
        frame.dataset.played = "1";
        const origin = new URL(frame.src).origin;
        expect(frame.src).toBe(`${origin}${BRIDGE_PAGE}`);
        // The bridge's window, as the app's page sees it: what it posts there, and what comes from it.
        const win = {
          postMessage: (data: { type?: string }, target: string) => {
            if (data?.type !== BRIDGE_CLEAR || target !== origin) return;
            asked.push(origin);
            if (!silent.includes(origin)) queueMicrotask(() => say(BRIDGE_CLEARED));
          },
        };
        Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
        const say = (type: string) => dispatchEvent(new MessageEvent("message", { data: { type }, origin, source: win as unknown as Window }));
        queueMicrotask(() => say(BRIDGE_READY));
      }
    });
    observer.observe(document.body, { childList: true });
    return { asked, stop: () => observer.disconnect() };
  }

  describe("the contacts' apps this device opened", () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => vi.useRealTimers());

    it("are cleared by chat: only the deleted chat's, each by the bridge on its own origin, and then off the list", async () => {
      noteOpened({ profile: "", tag: "chat-a", label: label("y") });
      noteOpened({ profile: "", tag: "chat-a", label: label("b") });
      noteOpened({ profile: "", tag: "chat-b", label: label("n") });
      noteOpened({ profile: "", tag: "chat-a", label: label("y") });
      expect(openedServices()).toHaveLength(3);
      const bridge = bridges();
      try {
        await forgetServices(host, { tag: "chat-a" });
      } finally { bridge.stop(); }
      expect(bridge.asked).toEqual([serviceOrigin(host, label("y")), serviceOrigin(host, label("b"))]);
      expect(openedServices()).toEqual([{ profile: "", tag: "chat-b", label: label("n") }]);
      expect(document.querySelectorAll("iframe"), "no frame left behind").toHaveLength(0);
    });

    it("are cleared by profile, never another profile's; and the list goes once empty", async () => {
      noteOpened({ profile: "", tag: "chat-a", label: label("y") });
      noteOpened({ profile: "work000001", tag: "chat-w", label: label("w") });
      const bridge = bridges();
      try {
        await forgetServices(host, { profile: "work000001" });
        expect(bridge.asked).toEqual([serviceOrigin(host, label("w"))]);
        expect(openedServices()).toEqual([{ profile: "", tag: "chat-a", label: label("y") }]);
        await forgetServices(host, { profile: "" });
      } finally { bridge.stop(); }
      expect(localStorage.getItem(OPENED_KEY)).toBeNull();
    });

    it("keeps on the list one whose bridge never answered, for a later clear, and the others go on without it", async () => {
      vi.useFakeTimers();
      noteOpened({ profile: "", tag: "chat-a", label: label("y") });
      noteOpened({ profile: "", tag: "chat-a", label: label("b") });
      const bridge = bridges([serviceOrigin(host, label("y"))]);
      try {
        const done = forgetServices(host, { tag: "chat-a" });
        await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
        await done;
      } finally { bridge.stop(); }
      expect(bridge.asked).toEqual([serviceOrigin(host, label("y")), serviceOrigin(host, label("b"))]);
      expect(openedServices().map((o) => o.label)).toEqual([label("y")]);
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it("are cleared all at once: offline, Clear all data waits one bridge's time, not one per app", async () => {
      vi.useFakeTimers();
      for (const c of "abcd") noteOpened({ profile: "work000001", tag: `chat-${c}`, label: label(c) });
      // No bridge loads (the device is offline): each frame waits its whole time.
      let finished = false;
      const done = forgetServices(host, { profile: "work000001" }).then(() => { finished = true; });
      expect(document.querySelectorAll("iframe")).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
      expect(finished).toBe(true);
      await done;
      expect(openedServices()).toHaveLength(4);
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it("of a profile deleted while no bridge answered are cleared at the next start, never a listed profile's", async () => {
      vi.useFakeTimers();
      for (const c of "abc") noteOpened({ profile: "gone000001", tag: `chat-${c}`, label: label(c) });
      noteOpened({ profile: "work000001", tag: "chat-w", label: label("w") });
      noteOpened({ profile: "", tag: "chat-y", label: label("y") });
      // Delete profile on a device that is offline: no bridge loads, and the profile leaves the list all the same.
      const done = forgetServices(host, { profile: "gone000001" });
      await vi.advanceTimersByTimeAsync(3 * CLEAR_ORIGIN_MS);
      await done;
      expect(openedServices().filter((o) => o.profile === "gone000001")).toHaveLength(3);
      vi.useRealTimers();
      // The next start, online: the profiles on the list are "" and work000001.
      const bridge = bridges();
      try {
        await forgetServicesOfGone(host, ["", "work000001"]);
      } finally { bridge.stop(); }
      expect(bridge.asked).toEqual([...("abc")].map((c) => serviceOrigin(host, label(c))));
      expect(openedServices()).toEqual([{ profile: "work000001", tag: "chat-w", label: label("w") }, { profile: "", tag: "chat-y", label: label("y") }]);
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it("of a chat deleted while no bridge answered are cleared at the next start, never a chat's it still has or another profile's", async () => {
      vi.useFakeTimers();
      noteOpened({ profile: "", tag: "chat-a", label: label("a") });
      noteOpened({ profile: "", tag: "chat-a", label: label("b") });
      noteOpened({ profile: "", tag: "chat-y", label: label("y") });
      noteOpened({ profile: "work000001", tag: "chat-w", label: label("w") });
      // Delete chat on a device that is offline: no bridge loads, and the chat and its link go all the same.
      const done = forgetServices(host, { tag: "chat-a" });
      await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
      await done;
      expect(openedServices().filter((o) => o.tag === "chat-a")).toHaveLength(2);
      vi.useRealTimers();
      // The next start, online, once the engine has loaded the chats: the profile "" has chat-y only.
      const bridge = bridges();
      try {
        await forgetServicesOfChatsGone(host, "", ["chat-y"]);
      } finally { bridge.stop(); }
      expect(bridge.asked).toEqual([serviceOrigin(host, label("a")), serviceOrigin(host, label("b"))]);
      expect(openedServices()).toEqual([{ profile: "", tag: "chat-y", label: label("y") }, { profile: "work000001", tag: "chat-w", label: label("w") }]);
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it("hears no other frame or origin: a page of the contact's saying it cleared does not take it off the list", async () => {
      vi.useFakeTimers();
      noteOpened({ profile: "", tag: "chat-a", label: label("y") });
      const done = forgetServices(host, { tag: "chat-a" });
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_CLEARED }, origin: serviceOrigin(host, label("y")), source: window }));
      await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
      await done;
      expect(openedServices()).toHaveLength(1);
    });

    it("reads past a list that is not one", () => {
      localStorage.setItem(OPENED_KEY, "{");
      expect(openedServices()).toEqual([]);
      localStorage.setItem(OPENED_KEY, JSON.stringify([{ profile: "", tag: "t", label: "not-a-label" }, null]));
      expect(openedServices()).toEqual([]);
    });
  });

  /** The cookies `document.cookie` reads as `seen`, and every write to it, while it runs. */
  function recordCookieWrites(seen: string) {
    const list: string[] = [];
    Object.defineProperty(document, "cookie", { configurable: true, get: () => seen, set: (value: string) => { list.push(value); } });
    return { list, stop: () => { delete (document as unknown as { cookie?: string }).cookie; } };
  }

  /**
   * A cookie jar as `document.cookie` shows it: each name it holds, at any path. It takes a cookie for the whole services
   * host only if `shared` (not when that host is a public suffix).
   */
  function cookieJar({ shared, live = [] }: { shared: boolean; live?: string[] }) {
    const names = new Set(live);
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => [...names].map((name) => `${name}=1`).join("; "),
      set: (value: string) => {
        if (value.includes("; Domain=") && !shared) return;
        const name = value.split("=")[0]!.trim();
        if (value.includes("Expires=Thu, 01 Jan 1970")) names.delete(name);
        else names.add(name);
      },
    });
    return { live: names, stop: () => { delete (document as unknown as { cookie?: string }).cookie; } };
  }

  /** The server's answer to the bridge's clear of the cookies, and the paths it was asked for. */
  function stubClearCookies(status: number): string[] {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (path: string) => { fetched.push(path); return new Response(null, { status }); });
    return fetched;
  }

  describe("the bridge's clear of its origin", () => {
    beforeEach(() => { stubClearCookies(204); });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("erases each kind the app may keep, and one the browser refuses keeps none of the others", async () => {
      localStorage.setItem("probe-k", "1");
      sessionStorage.setItem("probe-s", "1");
      document.cookie = "probe-c=1; Path=/";
      // The clock does not move while it clears: the cookie goes all the same.
      vi.useFakeTimers({ toFake: ["Date"] });
      const deleted: string[] = [];
      vi.stubGlobal("indexedDB", {
        databases: async () => [{ name: "probe-db" }, { name: "other" }],
        deleteDatabase: (name: string) => { deleted.push(name); const r = {} as IDBOpenDBRequest; queueMicrotask(() => r.onsuccess?.(new Event("success"))); return r; },
      });
      const cacheNames = new Set(["probe-cache"]);
      vi.stubGlobal("caches", { keys: async () => [...cacheNames], delete: async (key: string) => cacheNames.delete(key) });
      const unregistered = vi.fn(async () => true);
      const files = new Set(["a", "b"]);
      vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => { throw new Error("SecurityError"); } },
        serviceWorker: { getRegistrations: async () => [{ unregister: unregistered }] },
      });

      await clearSite(host.suffix);

      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(document.cookie).not.toContain("probe-c");
      expect(deleted).toEqual(["probe-db", "other"]);
      expect([...cacheNames]).toEqual([]);
      expect(unregistered, "the worker goes even though the file system refused").toHaveBeenCalledOnce();
      expect(files.size).toBe(2);
    });

    it("expires each cookie it sees for the whole services host too, as a frame under another site may write it", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const writes = recordCookieWrites("probe-c=1; link=profile-a");
      try {
        await clearSite(host.suffix);
      } finally { writes.stop(); }
      for (const name of ["probe-c", "link"]) {
        const of = (domain: string) => writes.list.filter((w) => w.startsWith(`${name}=;`) && w.includes("Expires=Thu, 01 Jan 1970") && w.includes(domain));
        expect(of(`Domain=${host.suffix}`).find((w) => w.includes("Secure; SameSite=None") && !w.includes("Partitioned")), `${name} on the services host`).toBeTruthy();
        expect(of(`Domain=${host.suffix}`).find((w) => w.includes("Partitioned")), `${name} on the services host, partitioned`).toBeTruthy();
        expect(writes.list.filter((w) => w.startsWith(`${name}=;`) && !w.includes("Domain=")).find((w) => w.includes("Secure; SameSite=None")), `${name} of this origin`).toBeTruthy();
      }
    });

    it("drops only the services host's cookies before it frames an app, never this origin's own", async () => {
      const writes = recordCookieWrites("mine=1; link=profile-a");
      try {
        await dropSharedCookies(host.suffix);
      } finally { writes.stop(); }
      expect(writes.list.length).toBeGreaterThan(0);
      expect(writes.list.every((w) => w.includes(`; Domain=${host.suffix}`)), "a host-only cookie is another one: it stays").toBe(true);
      const expired = writes.list.filter((w) => w.includes("Expires=Thu, 01 Jan 1970"));
      expect(new Set(expired.map((w) => w.split("=")[0]))).toEqual(new Set(["mine", "link"]));
    });

    it("has the server drop the services host's cookies at every path before it frames an app: one at Path=/t is never seen here", async () => {
      const jar = cookieJar({ shared: true });
      const fetched = stubClearCookies(204);
      try {
        await dropSharedCookies(host.suffix);
      } finally { jar.stop(); }
      expect(fetched).toEqual([CLEAR_COOKIES]);
      expect(jar.live.size, "its own probe is not left behind").toBe(0);
    });

    it("leaves this origin's own cookies when the browser takes none for the services host (a public suffix)", async () => {
      const jar = cookieJar({ shared: false, live: ["mine"] });
      const fetched = stubClearCookies(204);
      try {
        await dropSharedCookies(host.suffix);
      } finally { jar.stop(); }
      expect(fetched).toEqual([]);
      expect([...jar.live]).toEqual(["mine"]);
    });

    it("fails when the server did not clear them, so the app is not framed with another's cookie", async () => {
      const jar = cookieJar({ shared: true });
      stubClearCookies(404);
      try {
        await expect(dropSharedCookies(host.suffix)).rejects.toThrow();
      } finally { jar.stop(); }
    });

    it("has the server drop every cookie of the origin when it clears it, at every path, whatever the browser takes", async () => {
      vi.stubGlobal("indexedDB", undefined);
      const jar = cookieJar({ shared: false });
      const fetched = stubClearCookies(204);
      try {
        await clearSite(host.suffix);
      } finally { jar.stop(); }
      expect(fetched).toEqual([CLEAR_COOKIES]);
    });

    it("empties the origin-private file system", async () => {
      const files = new Set(["a", "b"]);
      vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => ({ async *keys() { yield* [...files]; }, removeEntry: async (name: string) => { files.delete(name); } }) },
        serviceWorker: { getRegistrations: async () => [] },
      });
      await clearSite(host.suffix);
      expect([...files]).toEqual([]);
    });

    it("deletes the storage buckets too: what an app put in its own bucket's IndexedDB, caches and files goes with it", async () => {
      const buckets = new Set(["kept", "other"]);
      vi.stubGlobal("navigator", {
        storage: { getDirectory: async () => ({ async *keys() {}, removeEntry: async () => {} }) },
        storageBuckets: { keys: async () => [...buckets], delete: async (name: string) => { buckets.delete(name); } },
        serviceWorker: { getRegistrations: async () => [] },
      });
      await clearSite(host.suffix);
      expect([...buckets]).toEqual([]);
    });
  });
});

// covers: settings.network.relay-only
describe("a contact's app while Hide my IP is on", () => {
  /**
   * Hide my IP from contacts on the web: no policy the page can send keeps Chromium from connecting to a server a frame
   * in a contact's app points at (its "Preload pages" connects first), so the web app opens no contact's app while the
   * setting is on, as the extension and `ghostly service open` do, and says why.
   */
  async function webHost() {
    vi.stubGlobal("__APP_VERSION__", "0.0.0");
    vi.stubGlobal("__APP_BUILD__", "test");
    vi.stubEnv("VITE_SERVICES_HOST", "https://*.svc.ghostly.example");
    vi.resetModules();
    return (await import("../../../../web/src/host")).webHost;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Its time is the web host's fresh import (its whole graph, after vi.resetModules()), not the check: a bound of its own.
  it("opens no contact's app while Hide my IP from contacts is on, and says why", { timeout: 30_000 }, async () => {
    const host = await webHost();
    await expect(host.openService!("o".repeat(52), "demo", "ybndrfg8ejkmcpqx", true))
      .rejects.toThrow("A contact's app does not open in the web app while Hide my IP from contacts is on");
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  });
});
