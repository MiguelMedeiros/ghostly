import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PAGE } from "../../../../web/src/svc/protocol";

// covers: services.web-open

/**
 * The services worker (apps/web/src/svc/worker.ts) on a contact's app origin, under a scope of its own: which
 * navigations it hands to the bridge, and so to the contact as this person. Only the app's own, in a frame: another
 * site may navigate a window or a frame of its own to the app's origin, and where the worker is in its partition (a
 * services host on the app's own site) that would reach the contact with the page's cookies.
 */
const ORIGIN = `https://${"y".repeat(32)}.svc.ghostly.example`;
const OTHER = "https://elsewhere.example";

interface Client { id: string; url: string; frameType: string; postMessage: ReturnType<typeof vi.fn> }
type FetchListener = (event: { request: unknown; clientId: string; respondWith(response: Promise<Response> | Response): void }) => void;

let clients: Client[];
let onFetch: FetchListener;
let bridge: Client;

beforeEach(async () => {
  vi.resetModules();
  // The contact answers everything it is handed with an empty 200.
  const answer = (_message: unknown, transfer: Transferable[]) => {
    const port = transfer[0] as MessagePort;
    port.postMessage({ type: "head", status: 200, headers: [] });
    port.postMessage({ type: "end" });
  };
  bridge = { id: "bridge", url: `${ORIGIN}${BRIDGE_PAGE}`, frameType: "nested", postMessage: vi.fn(answer) };
  clients = [bridge, { id: "app", url: `${ORIGIN}/`, frameType: "nested", postMessage: vi.fn() }];
  const scope = {
    location: new URL(`${ORIGIN}/ghostly-services-sw.js`),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => clients, get: async (id: string) => clients.find((client) => client.id === id) },
    addEventListener: (type: string, listener: FetchListener) => { if (type === "fetch") onFetch = listener; },
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
  vi.stubGlobal("__SERVICES_APP_ORIGIN__", "https://app.ghostly.example");
  await import("../../../../web/src/svc/worker");
});

afterEach(() => vi.unstubAllGlobals());

/** One request through the worker's fetch handler: whether it answered, and with what. */
function fetchThrough(request: { method?: string; path?: string; mode: string; destination: string; referrer: string; signal?: AbortSignal }, clientId = ""): Promise<Response> | null {
  let answer: Promise<Response> | null = null;
  const method = request.method ?? "GET";
  onFetch({
    request: { url: `${ORIGIN}${request.path ?? "/"}`, method, mode: request.mode, destination: request.destination, referrer: request.referrer, signal: request.signal ?? new AbortController().signal,
      headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }), body: method === "GET" ? null : new Response("a=1").body },
    clientId,
    respondWith: (response) => { answer = Promise.resolve(response); },
  });
  return answer;
}

describe("a navigation the services worker hands to the contact", () => {
  it("is a frame's this origin started: the bridge's first one, a link in the app, one of its pages with no referrer", async () => {
    void fetchThrough({ mode: "navigate", destination: "iframe", referrer: `${ORIGIN}${BRIDGE_PAGE}` });
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    void fetchThrough({ method: "POST", path: "/api/save", mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/form` });
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(2));
    void fetchThrough({ mode: "navigate", destination: "frame", referrer: "" }, "app");
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(3));
    expect(bridge.postMessage.mock.calls.map(([message]) => (message as { method: string; path: string }).method + " " + (message as { path: string }).path))
      .toEqual(["GET /", "POST /api/save", "GET /"]);
    // The app's own requests (a script, a fetch) are not navigations: they go as before.
    void fetchThrough({ method: "POST", path: "/api/echo", mode: "cors", destination: "", referrer: `${ORIGIN}/` }, "app");
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(4));
  });

  it("with no referrer and no client (Firefox's every one), goes on through a page that renders only inside Ghostly, as it was made", async () => {
    const { GO_KEY, GO_SCRIPT } = await import("../../../../web/src/svc/worker");
    const page = await fetchThrough({ method: "POST", path: "/api/save?x=1", mode: "navigate", destination: "iframe", referrer: "" })!;
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(GO_SCRIPT)));
    expect(page.headers.get("content-security-policy"))
      .toBe(`frame-ancestors 'self' https://app.ghostly.example; default-src 'none'; script-src 'sha256-${btoa(String.fromCharCode(...digest))}'`);
    const token = /<script data-go="([0-9a-f-]+)">/.exec(await page.text())?.[1];
    expect(token).toBeTruthy();
    // Nothing reached the contact: in another site's frame the page never renders, and no one asks again.
    expect(bridge.postMessage).not.toHaveBeenCalled();
    // Its script asks again, its token in the referrer: the kept POST goes, body and all, once.
    const again = { path: "/api/save?x=1", mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/api/save?x=1&${GO_KEY}=${token}` };
    void fetchThrough(again);
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(1));
    const [message] = bridge.postMessage.mock.calls[0] as [{ method: string; path: string; body: ArrayBuffer }];
    expect([message.method, message.path, new TextDecoder().decode(message.body)]).toEqual(["POST", "/api/save?x=1", "a=1"]);
    void fetchThrough(again);
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(2));
    expect((bridge.postMessage.mock.calls[1]![0] as { method: string }).method).toBe("GET");
    // A token goes only with the address it was kept for.
    const other = await fetchThrough({ method: "POST", path: "/api/delete", mode: "navigate", destination: "iframe", referrer: "" })!;
    const otherToken = /data-go="([^"]+)"/.exec(await other.text())![1];
    void fetchThrough({ path: "/account", mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/?${GO_KEY}=${otherToken}` });
    await vi.waitFor(() => expect(bridge.postMessage).toHaveBeenCalledTimes(3));
    expect((bridge.postMessage.mock.calls[2]![0] as { method: string; path: string }).method).toBe("GET");
  });

  it("is never another site's: its form POST at the top or into a frame of its own, or a window it opens", async () => {
    const tries = [
      { method: "POST", path: "/api/delete", mode: "navigate", destination: "document", referrer: `${OTHER}/` },
      { method: "POST", path: "/api/delete", mode: "navigate", destination: "iframe", referrer: `${OTHER}/` },
      { path: "/account", mode: "navigate", destination: "document", referrer: "" },
      { path: "/account", mode: "navigate", destination: "iframe", referrer: "" },
      // Its referrer is this origin's, but it opens at the top, not in Ghostly's frame.
      { path: "/account", mode: "navigate", destination: "document", referrer: `${ORIGIN}/` },
    ];
    for (const one of tries) {
      const answer = fetchThrough(one, one.referrer ? "" : "elsewhere");
      expect(answer, JSON.stringify(one)).not.toBeNull();
      const response = await answer!;
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("This app opens only inside Ghostly.");
      expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://app.ghostly.example");
    }
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });
});

describe("an answer of the contact's app the worker passes on", () => {
  it("carries Ghostly's viewer policy after the app's own, Hide my IP on or off, whatever policy the app sends", async () => {
    const { CookieJar, serve } = await import("../../../../web/src/svc/opener");
    const { VIEWER_GUARD_CSP, VIEWER_SERVICE_CSP, VIEWER_SERVICE_CSP_RELAY_ONLY } = await import("@ghostly/core");
    const words = { unreachable: "", failed: "", close: "", callOn: "", tooSlow: "", offline: "", retry: "", blocked: "", unguarded: "", label: "", owner: "", openLink: () => "", hostError: () => null };
    for (const own of [null, "connect-src *"]) {
      for (const relayOnly of [false, true]) {
        // The bridge hands the request to the real `serve`, and the contact answers with or without a policy of its own.
        bridge.postMessage.mockImplementation((message: unknown, transfer: Transferable[]) => {
          const headers: [string, string][] = [["content-type", "text/html"], ...(own ? [["content-security-policy", own] as [string, string]] : [])];
          void serve(transfer[0] as MessagePort, message, async () => ({ status: 200, headers, body: (async function* () {})(), bytes: async () => new Uint8Array() }), new CookieJar(), words, undefined, relayOnly);
        });
        const response = await fetchThrough({ mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/` }, "app")!;
        // The guards' policy comes with the guards (`guardViewerAnswer`: the clipboard guard always, the WebRTC guard with
        // Hide my IP on), before the viewer's.
        const policy = [VIEWER_GUARD_CSP, relayOnly ? VIEWER_SERVICE_CSP_RELAY_ONLY : VIEWER_SERVICE_CSP];
        expect(response.headers.get("content-security-policy"), `${own} ${relayOnly}`).toBe([own, ...policy, "frame-ancestors 'self' https://app.ghostly.example"].filter(Boolean).join(", "));
      }
    }
  });
});

describe("a request the app's page could not get an answer to", () => {
  it("is said in the profile's language and direction, as a page with nothing to run: never the worker's plain English", async () => {
    bridge.postMessage.mockImplementation((_message: unknown, transfer: Transferable[]) => {
      (transfer[0] as MessagePort).postMessage({ type: "error", status: 503, text: "لا يمكن الوصول <b>إليه</b>", lang: "ar", dir: "rtl" });
    });
    const response = await fetchThrough({ mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/` }, "app")!;
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://app.ghostly.example; default-src 'none'; style-src 'unsafe-inline'");
    const html = await response.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("<p>لا يمكن الوصول &#60;b&#62;إليه&#60;/b&#62;</p>");
    expect(html).not.toContain("<script");
  });

  it("keeps a page language it cannot vouch for out of the page", async () => {
    bridge.postMessage.mockImplementation((_message: unknown, transfer: Transferable[]) => {
      (transfer[0] as MessagePort).postMessage({ type: "error", status: 502, text: "Failed", lang: 'en" onload="x', dir: "sideways" });
    });
    const html = await (await fetchThrough({ mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/` }, "app")!).text();
    expect(html).toContain("<html><head>");
  });

  it("ends at a status a Response takes, whatever status the app's error comes with: never left waiting", async () => {
    // As Chromium and Firefox build a Response (the test DOM's takes anything): refused outside 200-599, and with a
    // body at a status that carries none.
    const Native = globalThis.Response;
    class BrowserResponse extends Native {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        const status = init?.status ?? 200;
        if (status < 200 || status > 599) throw new RangeError(`The status provided (${status}) is outside the range [200, 599].`);
        if (body != null && [101, 103, 204, 205, 304].includes(status)) throw new TypeError("Response with null body status cannot have body");
        super(body, init);
      }
    }
    vi.stubGlobal("Response", BrowserResponse);
    const statuses: [number, number][] = [[204, 204], [205, 205], [304, 304], [0, 502], [99, 502], [600, 502], [700, 502], [502, 502]];
    for (const [sent, kept] of statuses) {
      for (const lang of [undefined, "en"]) {
        bridge.postMessage.mockImplementation((_message: unknown, transfer: Transferable[]) => {
          (transfer[0] as MessagePort).postMessage({ type: "error", status: sent, text: "Not here", lang });
        });
        const waiting = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000));
        const response = await Promise.race([fetchThrough({ mode: "navigate", destination: "iframe", referrer: `${ORIGIN}/` }, "app")!, waiting]);
        const label = `${sent} ${lang ?? "plain"}`;
        expect(response, label).not.toBeNull();
        expect(response!.status, label).toBe(kept);
        expect(response!.headers.get("content-security-policy"), label).toMatch(/^frame-ancestors 'self' https:\/\/app\.ghostly\.example(;|$)/);
        const text = await response!.text();
        if ([204, 205, 304].includes(kept)) expect(text, label).toBe("");
        else expect(text, label).toContain("Not here");
      }
    }
  });

  it("passes a fetch the app gives up on before any answer on as cancelled: the page lets go of it, and its body", async () => {
    let port: MessagePort | undefined;
    const said: unknown[] = [];
    bridge.postMessage.mockImplementation((_message: unknown, transfer: Transferable[]) => {
      port = transfer[0] as MessagePort;
      port.onmessage = (event) => said.push(event.data);
    });
    const controller = new AbortController();
    void fetchThrough({ method: "POST", path: "/up", mode: "cors", destination: "", referrer: `${ORIGIN}/`, signal: controller.signal }, "app");
    await vi.waitFor(() => expect(port).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(said).toEqual([{ type: "cancel" }]));
  });

  it("hands the frame the answer only as it reads, and tells the page what it read: the page sends no more than that ahead", async () => {
    let port: MessagePort | undefined;
    let asked: unknown;
    const said: unknown[] = [];
    bridge.postMessage.mockImplementation((message: unknown, transfer: Transferable[]) => {
      asked = message;
      port = transfer[0] as MessagePort;
      port.onmessage = (event) => said.push(event.data);
      port.postMessage({ type: "head", status: 200, headers: [] });
      for (const n of [3, 4, 5]) port.postMessage({ type: "chunk", bytes: new Uint8Array(n).fill(n) });
    });
    const response = await fetchThrough({ path: "/video.mp4", mode: "no-cors", destination: "video", referrer: `${ORIGIN}/` }, "app")!;
    expect(asked).toMatchObject({ type: "request", flow: true });
    // Nothing read yet: nothing said, however much came.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(said).toEqual([]);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array(3).fill(3));
    await vi.waitFor(() => expect(said).toEqual([{ type: "read", bytes: 3 }]));
    expect((await reader.read()).value).toEqual(new Uint8Array(4).fill(4));
    expect((await reader.read()).value).toEqual(new Uint8Array(5).fill(5));
    await vi.waitFor(() => expect(said).toEqual([{ type: "read", bytes: 3 }, { type: "read", bytes: 7 }, { type: "read", bytes: 12 }]));
    // The rest, read before it came, goes straight on; then the end.
    const next = reader.read();
    port!.postMessage({ type: "chunk", bytes: new Uint8Array(2).fill(2) });
    expect((await next).value).toEqual(new Uint8Array(2).fill(2));
    port!.postMessage({ type: "end" });
    expect((await reader.read()).done).toBe(true);
  });
});
