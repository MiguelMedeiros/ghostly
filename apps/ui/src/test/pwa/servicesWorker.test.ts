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
    clients: { claim: async () => {}, matchAll: async () => clients },
    addEventListener: (type: string, listener: FetchListener) => { if (type === "fetch") onFetch = listener; },
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
  vi.stubGlobal("__SERVICES_APP_ORIGIN__", "https://app.ghostly.example");
  await import("../../../../web/src/svc/worker");
});

afterEach(() => vi.unstubAllGlobals());

/** One request through the worker's fetch handler: whether it answered, and with what. */
function fetchThrough(request: { method?: string; path?: string; mode: string; destination: string; referrer: string }, clientId = ""): Promise<Response> | null {
  let answer: Promise<Response> | null = null;
  const method = request.method ?? "GET";
  onFetch({
    request: { url: `${ORIGIN}${request.path ?? "/"}`, method, mode: request.mode, destination: request.destination, referrer: request.referrer,
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
