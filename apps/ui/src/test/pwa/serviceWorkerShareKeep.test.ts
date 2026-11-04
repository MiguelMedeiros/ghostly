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

async function startWorker(scope = "https://app.ghostly.tools/", windows: { id: string }[] = []) {
  const listeners = new Map<string, (event: Message) => void>();
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", []);
  vi.stubGlobal("self", {
    location: new URL("https://app.ghostly.tools/sw.js"),
    registration: { scope },
    clients: { matchAll: async () => windows },
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

it("a share forwarded goes to one window: the app's page of the same profile focused last, never another profile's", async () => {
  const work = page("work");
  const older = page("home-older");
  const home = page("home");
  const opened = page("opened");
  const worker = await startWorker(undefined, [work, older, home, opened]);
  worker.say({ type: "share-here", profile: "home" }, older);
  worker.say({ type: "share-here", profile: "home" }, home);
  worker.say({ type: "share-here", profile: "work" }, work);
  const item = { title: "", text: "for Ana", url: "", files: [] };
  worker.say({ type: "share-keep", item }, opened);

  worker.say({ type: "share-forward", profile: "home" }, opened);
  await Promise.all(worker.waits.slice(1));
  expect(home.heard).toEqual([{ type: "share", item }]);
  expect(older.heard).toEqual([]);
  expect(work.heard).toEqual([]);
  expect(opened.heard).toEqual([]);
});

it("no page of the profile to forward it to: it waits, and goes to the first of that profile that says it is there", async () => {
  const work = page("work");
  const opened = page("opened");
  const home = page("home");
  const worker = await startWorker(undefined, [work, opened, home]);
  worker.say({ type: "share-here", profile: "work" }, work);
  const item = { title: "", text: "for Ana", url: "", files: [] };
  worker.say({ type: "share-keep", item }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await Promise.all(worker.waits.slice(1));
  expect(work.heard).toEqual([]);

  // The worker stopped and started again meanwhile, or the profile's page was not there yet: it says so when it is.
  worker.say({ type: "share-here", profile: "work" }, work);
  expect(work.heard).toEqual([]);
  worker.say({ type: "share-here", profile: "home" }, home);
  expect(home.heard).toEqual([{ type: "share", item }]);
});
