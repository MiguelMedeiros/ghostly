import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CookieJar, openServiceView, serve, serviceLabel } from "../../../../web/src/svc/opener";
import { closeServiceWindows, setServiceWindowsCloser } from "../../lib/serviceWindows";
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

const words = { unreachable: "Not reachable", failed: "Failed", close: "Close" };

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

  it("closes when the profile locks (the lock screen's closeServiceWindows), as Desktop's windows do", async () => {
    setServiceWindowsCloser(closeServiceView);
    await open("one");
    expect(document.getElementById(SERVICE_VIEW_ID)).not.toBeNull();
    closeServiceWindows();
    expect(document.getElementById(SERVICE_VIEW_ID)).toBeNull();
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
