import { afterEach, describe, expect, it, vi } from "vitest";
import type { FromWorker } from "../../../../web/src/sw/messages";

// covers: app.pwa.share-target

/**
 * What another app shares into the installed web app, through the worker's own script (`apps/web/src/sw/sw.ts`) in a
 * stand-in scope: the share target's POST, then the opened page's "share-ready" and what the worker answers it.
 */
const ORIGIN = "https://app.ghostly.tools";
const MiB = 1024 * 1024;

type Listener = (event: object) => void;

async function startWorker() {
  const listeners = new Map<string, Listener>();
  vi.stubGlobal("__SW_BUILD__", "test");
  vi.stubGlobal("__SW_PRECACHE__", ["/"]);
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    clients: { matchAll: async () => [] },
    addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
  });
  // A worker resolves the redirect against its own address; Node has none.
  const redirect = Response.redirect.bind(Response);
  vi.spyOn(Response, "redirect").mockImplementation((url, status) => redirect(new URL(url, ORIGIN).href, status));
  vi.resetModules();
  await import("../../../../web/src/sw/sw");
  return { onFetch: listeners.get("fetch")!, onMessage: listeners.get("message")! };
}

/** A share POST through the worker, then what the page that opened for it is told. */
async function shareThenAsk(request: { method: string; url: string; mode: string; headers: Headers; body: ReadableStream<Uint8Array> | null }): Promise<FromWorker> {
  const { onFetch, onMessage } = await startWorker();
  let answer: Promise<Response> | Response | undefined;
  onFetch({ request, respondWith: (response: Promise<Response> | Response) => { answer = response; }, waitUntil: () => {} });
  expect((await answer)!.status).toBe(303);
  const told: FromWorker[] = [];
  onMessage({ data: { type: "share-ready" }, source: { id: "page", url: `${ORIGIN}/#/shared`, postMessage: (message: FromWorker) => told.push(message) }, waitUntil: () => {} });
  return told[0]!;
}

/** A body of `mib` MiB, pulled a MiB at a time (a phone's video, as the system's share sheet posts it). */
function body(mib: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({ pull(controller) { if (sent++ >= mib) controller.close(); else controller.enqueue(new Uint8Array(MiB)); } });
}

const post = (headers: Record<string, string>, stream: ReadableStream<Uint8Array>) =>
  ({ method: "POST", url: `${ORIGIN}/share-target`, mode: "navigate", headers: new Headers(headers), body: stream });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a share into the installed web app", () => {
  it("a small file is handed to the page", async () => {
    const form = new FormData();
    form.append("files", new File(["boo"], "small.txt", { type: "text/plain" }));
    const sent = new Request(`${ORIGIN}/share-target`, { method: "POST", body: form });
    const told = await shareThenAsk({ method: "POST", url: sent.url, mode: "navigate", headers: sent.headers, body: sent.body });
    expect(told).toMatchObject({ type: "share", item: { files: [expect.objectContaining({ name: "small.txt" })] } });
    expect(told.type === "share" && told.item.leftOut).toBeFalsy();
  });

  it("over 64 MiB with no length said: the page is told a file was too large, not that nothing was shared", async () => {
    const told = await shareThenAsk(post({ "content-type": "multipart/form-data; boundary=x" }, body(65)));
    // Never read, so its name is not known.
    expect(told).toEqual({ type: "share", item: { title: "", text: "", url: "", files: [], leftOut: [""] } });
  });

  it("a length over 64 MiB said up front: the same, without reading it", async () => {
    const told = await shareThenAsk(post({ "content-type": "multipart/form-data; boundary=x", "content-length": String(300 * 1024 * 1024) }, body(1)));
    expect(told).toEqual({ type: "share", item: { title: "", text: "", url: "", files: [], leftOut: [""] } });
  });
});
