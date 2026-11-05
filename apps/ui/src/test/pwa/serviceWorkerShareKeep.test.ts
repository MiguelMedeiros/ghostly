import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHARE_LOCK_LOOK_MS } from "../../../../web/src/sw/messages";

// covers: app.pwa.share-target

/**
 * A share still in the picker when the page restarts (a profile switch): the page hands it back to the web app's
 * service worker (apps/web/src/sw/sw.ts), which holds it again for the page that loads next, as a share just posted.
 * The worker's own script runs here against a stand-in for its scope.
 */

// A forward waits between its looks at the peer locks: the clock is moved by hand (`looked`).
beforeEach(() => { vi.useFakeTimers(); });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Message = { data: unknown; source: { id: string; postMessage(message: unknown): void } | null; waitUntil(promise: Promise<unknown>): void };

/**
 * `locks`: the peer lock each window holds, by window id, as the browser keeps it (it lets go of a page's by itself when
 * the page dies). Left out: a browser with no Web Locks in workers.
 */
async function startWorker(scope = "https://app.ghostly.tools/", windows: { id: string }[] = [], locks?: Map<string, string>) {
  const listeners = new Map<string, (event: Message) => void>();
  vi.stubGlobal("__SW_BUILD__", "test-1");
  vi.stubGlobal("__SW_PRECACHE__", []);
  vi.stubGlobal("self", {
    location: new URL("https://app.ghostly.tools/sw.js"),
    registration: { scope },
    clients: { matchAll: async () => windows },
    ...(locks && { navigator: { locks: { query: async () => ({ held: [...locks].map(([clientId, name]) => ({ name, clientId, mode: "exclusive" })) }) } } }),
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
  /** Every forward asked for so far has looked at the locks as often as it does, and is over. */
  const looked = async () => {
    await vi.advanceTimersByTimeAsync(3 * SHARE_LOCK_LOOK_MS);
    await Promise.all(waits.slice(1));
  };
  return { say, post, waits, looked };
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
  await worker.looked();
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
  await worker.looked();
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
  await worker.looked();
  expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
});

it("no page to forward to yet: the tab that asked hears it went once one says it is there; nothing held, it hears there is none", async () => {
  const opened = page("opened");
  const home = page("home");
  const worker = await startWorker(undefined, [opened, home]);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await worker.looked();
  expect(opened.heard).toEqual([]);
  worker.say({ type: "share-here", profile: "home" }, home);
  expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);

  const late = page("late");
  worker.say({ type: "share-forward", profile: "home" }, late);
  expect(late.heard).toEqual([{ type: "share-none" }]);
});

it("the app's page that went without a word (no pagehide, no share-away) lets go of its lock: the share goes to the live app tab", async () => {
  const gone = page("gone");
  const live = page("live");
  const opened = page("opened");
  const locks = new Map([["lock-gone", "ghostly-peer-home"]]);
  const worker = await startWorker(undefined, [live, gone, opened], locks);
  worker.say({ type: "share-here", profile: "home", lock: "lock-live" }, live);
  worker.say({ type: "share-here", profile: "home", lock: "lock-gone" }, gone);
  // The phone killed it: still listed a moment, in front last, but the browser let go of its lock, which `live` took.
  locks.clear();
  locks.set("lock-live", "ghostly-peer-home");
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await worker.looked();
  expect(gone.heard).toEqual([]);
  expect(live.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  // The waiting tab says "Sent…".
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
});

it("the only app's page went without a word: the share is kept for the next app page, and the waiting tab hears it went", async () => {
  const gone = page("gone");
  const opened = page("opened");
  const next = page("next");
  const locks = new Map([["lock-gone", "ghostly-peer"]]);
  const worker = await startWorker(undefined, [gone, opened, next], locks);
  worker.say({ type: "share-here", profile: "home", lock: "lock-gone" }, gone);
  locks.clear();
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await worker.looked();
  expect(gone.heard).toEqual([]);
  expect(opened.heard).toEqual([]);
  locks.set("lock-next", "ghostly-peer");
  worker.say({ type: "share-here", profile: "home", lock: "lock-next" }, next);
  expect(next.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
});

it("a share into the same window, nothing said by the page it replaces: never forwarded to it while it still holds its lock on the way out", async () => {
  const leaving = page("leaving");
  const opened = page("opened");
  const locks = new Map([["lock-leaving", "ghostly-peer-home"]]);
  const worker = await startWorker(undefined, [leaving, opened], locks);
  worker.say({ type: "share-here", profile: "home", lock: "lock-leaving" }, leaving);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  // Its lock goes before the worker looks again: the tab opened for the share takes it, and asks for the share itself.
  await vi.advanceTimersByTimeAsync(SHARE_LOCK_LOOK_MS / 2);
  locks.clear();
  locks.set("lock-opened", "ghostly-peer-home");
  await worker.looked();
  expect(leaving.heard).toEqual([]);
  worker.say({ type: "share-ready" }, opened);
  expect(opened.heard).toEqual([{ type: "share", item: item("for Ana") }]);
});

it("an app tab that keeps its lock gets the share forwarded", async () => {
  const home = page("home");
  const opened = page("opened");
  const worker = await startWorker(undefined, [home, opened], new Map([["lock-home", "ghostly-peer-home"], ["lock-other", "ghostly-peer-work"]]));
  // Web Locks names it otherwise than the worker does (Chromium): as the page said.
  worker.say({ type: "share-here", profile: "home", lock: "lock-home" }, home);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await vi.advanceTimersByTimeAsync(0);
  // Not before it held the lock on a second look.
  expect(home.heard).toEqual([]);
  await worker.looked();
  expect(home.heard).toEqual([{ type: "share", item: item("for Ana") }]);
  expect(opened.heard).toEqual([{ type: "share-forwarded" }]);
});

it("a share forwarded never goes to the app's page on its way out (a share into the same window replaced it)", async () => {
  const leaving = page("leaving");
  const opened = page("opened");
  const next = page("next");
  // It said it goes: the worker need not wait for the lock it still holds.
  const worker = await startWorker(undefined, [leaving, opened, next], new Map([["lock-leaving", "ghostly-peer-home"]]));
  worker.say({ type: "share-here", profile: "home", lock: "lock-leaving" }, leaving);
  worker.say({ type: "share-away" }, leaving);
  worker.say({ type: "share-keep", item: item("for Ana") }, opened);
  // The tab opened for it goes before its wait is over: it forwards at once.
  worker.say({ type: "share-forward", profile: "home" }, opened);
  await worker.looked();
  expect(leaving.heard).toEqual([]);
  // Held for the next page of the profile instead.
  worker.say({ type: "share-here", profile: "home" }, next);
  expect(next.heard).toEqual([{ type: "share", item: item("for Ana") }]);
});
