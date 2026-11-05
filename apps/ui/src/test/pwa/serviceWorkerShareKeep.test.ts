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
  /** Another app shares `text`: a POST to the share target, held once the worker read it. */
  const post = async (text: string) => {
    const form = new FormData();
    form.set("text", text);
    const request = new Request("https://app.ghostly.tools/share-target", { method: "POST", body: form });
    let answered: Promise<unknown> = Promise.resolve();
    listeners.get("fetch")!({ request, respondWith: (answer: Promise<unknown>) => { answered = answer; }, waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as never);
    await answered.catch(() => {});
  };
  return { say, post, waits };
}

const item = (text: string) => ({ title: "", text, url: "", files: [] });

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

it("shares posted past the three it holds are counted, and the page that takes the others is told how many", async () => {
  const worker = await startWorker();
  for (const text of ["one", "two", "three", "four", "five"]) await worker.post(text);
  const next = page("b");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([
    { type: "share", item: expect.objectContaining(item("one")) },
    { type: "share", item: expect.objectContaining(item("two")) },
    { type: "share", item: expect.objectContaining(item("three")), dropped: 2 },
  ]);
  // Told once.
  await worker.post("six");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard[next.heard.length - 1]).toEqual({ type: "share", item: expect.objectContaining(item("six")) });
});

it("a page that goes with shares in its picker (a share into the same window) has them held ahead of the share it went for", async () => {
  const worker = await startWorker();
  // The window posts a new share: the worker holds it, and the page it replaces gives back the two in its picker.
  await worker.post("new");
  const leaving = page("a");
  worker.say({ type: "share-keep", item: item("shown") }, leaving);
  worker.say({ type: "share-keep", item: item("behind") }, leaving);
  const next = page("b");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([
    { type: "share", item: item("shown") },
    { type: "share", item: item("behind") },
    { type: "share", item: expect.objectContaining(item("new")) },
  ]);
});

it("a page that goes with three shares in its picker keeps all three: the share it went for is the one past them", async () => {
  const worker = await startWorker();
  await worker.post("new");
  const leaving = page("a");
  for (const text of ["shown", "second", "third"]) worker.say({ type: "share-keep", item: item(text) }, leaving);
  const next = page("b");
  worker.say({ type: "share-ready" }, next);
  expect(next.heard).toEqual([
    { type: "share", item: item("shown") },
    { type: "share", item: item("second") },
    { type: "share", item: item("third"), dropped: 1 },
  ]);
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
  // Only that it went.
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
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

it("the tab that asked for a forward is told once the share is handed over, and not before", async () => {
  const home = page("home");
  const opened = page("opened");
  const worker = await startWorker(undefined, [home, opened]);
  worker.say({ type: "share-here", profile: "home" }, home);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  expect(opened.heard).toEqual([]);
  await Promise.all(worker.waits.slice(1));
  expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
});

it("no page to forward to yet: the tab that asked hears it went once one says it is there; nothing held, it hears there is none", async () => {
  const opened = page("opened");
  const home = page("home");
  const worker = await startWorker(undefined, [opened, home]);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await Promise.all(worker.waits.slice(1));
  expect(opened.heard).toEqual([]);
  worker.say({ type: "share-here", profile: "home" }, home);
  expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);

  const late = page("late");
  worker.say({ type: "share-forward", profile: "home" }, late);
  expect(late.heard).toEqual([{ type: "share-none" }]);
});

it("a share forwarded never goes to the app's page on its way out (a share into the same window replaced it)", async () => {
  const leaving = page("leaving");
  const opened = page("opened");
  const next = page("next");
  const worker = await startWorker(undefined, [leaving, opened, next]);
  worker.say({ type: "share-here", profile: "home" }, leaving);
  worker.say({ type: "share-away" }, leaving);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  // The tab opened for it goes before its wait is over: it forwards at once.
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await Promise.all(worker.waits.slice(1));
  expect(leaving.heard).toEqual([]);
  // Held for the next page of the profile instead.
  worker.say({ type: "share-here", profile: "home" }, next);
  expect(next.heard).toEqual([{ type: "share", item: item("for Ana") }]);
});
