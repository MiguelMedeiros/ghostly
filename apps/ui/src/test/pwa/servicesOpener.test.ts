import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, openServiceView, serve, serviceLabel } from "../../../../web/src/svc/opener";
import { closeServiceWindows, hostErrorText, setServiceWindowsCloser } from "../../lib/serviceWindows";
import { translatorFor } from "../../locales";
import { SERVICE_VIEW_ID, closeServiceView, isServiceHostname, parseServicesHost, serviceOrigin, type ServiceReply } from "../../../../web/src/svc/protocol";
import { GhostlyHttpError, type ClientRequest, type ClientResponse } from "@ghostly/core";

// covers: services.web-open

/**
 * Opening a contact's shared web app on the web (apps/web/src/svc/opener.ts): the origin it gets, the cookies it keeps,
 * the answer it streams back, and the view it is shown in (the protocol itself: servicesProtocol.test.ts). The browser's own part (the worker under the bridge) is e2e/web/services-web-open.spec.ts.
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const PEER = "o".repeat(52);

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

const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", hostError: () => null };

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
    expect(replies[0]).toEqual({ type: "head", status: 200, headers: [["content-type", "text/plain"]] });
    expect(replies.slice(1, 3).map((r) => r.type === "chunk" && new TextDecoder().decode(r.bytes))).toEqual(["he", "llo"]);
    expect(replies[replies.length - 1]).toEqual({ type: "end" });
    expect(jar.header()).toBe("sid=abc; theme=dark");
    expect(closed()).toBe(true);
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
      [503, "busy", "Too many requests.", "services.window.failed"],
    ] as const) {
      const { port, replies } = recorder();
      await serve(port, { type: "request", method: "GET", path: "/", headers: [], body: null },
        async () => answer(status, [["content-type", "text/plain; charset=utf-8"], ["x-ghostly-error", code]], [`${english}\n`]), new CookieJar(), said);
      expect(replies).toEqual([{ type: "error", status, text: t(key, { app: "Demo" }) }]);
      expect(replies[0]!.type === "error" && replies[0]!.text).not.toContain(english);
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

  it("drops what is not a request, sending nothing", async () => {
    const { port, replies, closed } = recorder();
    let called = false;
    await serve(port, { type: "request", method: "GET", path: "https://evil.example/", headers: [], body: null }, async () => { called = true; return answer(200, [], []); }, new CookieJar(), words);
    expect(called).toBe(false);
    expect(replies).toEqual([]);
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

  it("is one at a time: opening another closes the one before", async () => {
    await open("one");
    await open("two");
    expect(document.querySelectorAll(`#${SERVICE_VIEW_ID}`)).toHaveLength(1);
    expect(document.getElementById(SERVICE_VIEW_ID)?.getAttribute("aria-label")).toBe("two");
  });

  it("closes when the profile locks (the lock screen's closeServiceWindows), as Desktop's windows do", async () => {
    setServiceWindowsCloser(closeServiceView);
    await open("one");
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
    closeServiceWindows();
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
  });
});
