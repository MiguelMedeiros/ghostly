import { afterEach, expect, it, vi } from "vitest";

// covers: app.pwa.share-target

/**
 * A share still in the picker when the page restarts (a profile switch): the page hands it back to the web app's
 * service worker (apps/web/src/sw/sw.ts), which holds it again for the page that loads next, as a share just posted.
 * The worker's own script runs here against a stand-in for its scope.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Message = { data: unknown; source: { id: string; postMessage(message: unknown): void } | null; waitUntil(promise: Promise<unknown>): void };

async function startWorker(scope = "https://app.ghostly.tools/") {
  const listeners = new Map<string, (event: Message) => void>();
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", []);
  vi.stubGlobal("self", {
    location: new URL("https://app.ghostly.tools/sw.js"),
    registration: { scope },
    addEventListener: (type: string, listener: (event: Message) => void) => { listeners.set(type, listener); },
  });
  await import("../../../../web/src/sw/sw");
  const waits: Promise<unknown>[] = [];
  const say = (data: unknown, source: Message["source"]) => listeners.get("message")!({ data, source, waitUntil: (promise) => { waits.push(promise); } });
  return { say, waits };
}

const page = (id: string) => {
  const heard: unknown[] = [];
  return { id, heard, postMessage: (message: unknown) => { heard.push(message); } };
};

it("holds a share the page gave back until the next page asks for it, and stays up meanwhile", async () => {
  const worker = await startWorker();
  const item = { title: "", text: "for Ana", url: "", files: [] };
  const leaving = page("a");
  worker.say({ type: "share-keep", item }, leaving);
  expect(worker.waits).toHaveLength(1);
  let settled = false;
  void worker.waits[0]!.then(() => { settled = true; });

  const next = page("b");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([{ type: "share", item }]);
  await Promise.resolve();
  expect(settled).toBe(true);
  // Handed over once.
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([{ type: "share", item }, { type: "share-none" }]);
});

it("a profile's push worker holds nothing", async () => {
  const worker = await startWorker("https://app.ghostly.tools/push/default/");
  worker.say({ type: "share-keep", item: { title: "", text: "hi", url: "", files: [] } }, page("a"));
  expect(worker.waits).toEqual([]);
  const next = page("b");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([{ type: "share-none" }]);
});
