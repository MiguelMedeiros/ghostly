import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FromWorker } from "../../../../web/src/sw/messages";
import { clearWakeEntries, writeWakeText } from "../../../../web/src/sw/wakeStore";

// covers: push.wake.notify

/**
 * A tap on a wake-up notification, through the push worker's own script (`apps/web/src/sw/sw.ts`) in a stand-in scope:
 * which window of the app is brought forward and told to open the chat. Two windows are common (the installed app and
 * a tab, or two profiles side by side): the tap goes to the one that runs the notice's profile, never to a tab waiting
 * behind another or to another profile's window, which would switch away from the profile it runs.
 */
const ORIGIN = "https://app.ghostly.tools";

type Listener = (event: object) => void;

/**
 * A window of the app. `says` is what its page answers when asked what it runs; undefined: it never answers (an older
 * build, or frozen). `takes`: what it answers once told to open a chat it was only guessed for; undefined, nothing.
 * `frozen`: it answers that only once the tap has focused it (a frozen page runs nothing until then).
 */
function appWindow(id: string, says?: { profile: string; peer: boolean }, extra: { focused?: boolean; visibilityState?: string; takes?: boolean; frozen?: boolean } = {}) {
  const told: FromWorker[] = [];
  let held: (() => void) | undefined;
  const window = {
    id, url: `${ORIGIN}/#/`, focused: false, visibilityState: "hidden", ...extra, told, focusedByTap: false,
    /** The tap's one window interaction (`startPushWorker`): a focus spends it. */
    interact: () => {},
    postMessage(message: FromWorker, transfer?: MessagePort[]) {
      if (message.type === "open-ask") { if (says) transfer?.[0]?.postMessage(says); return; }
      const answer = () => {
        told.push(message);
        if (message.type === "open-chat" && extra.takes !== undefined) transfer?.[0]?.postMessage({ taken: extra.takes });
      };
      if (extra.frozen && !window.focusedByTap) held = answer;
      else answer();
    },
    async focus() {
      window.interact();
      window.focusedByTap = true;
      held?.();
      held = undefined;
      return window;
    },
  };
  return window;
}

/** `locks`: the peer locks held, by name, as the worker's Web Locks lists them; undefined, a browser without them in workers. */
async function startPushWorker(windows: ReturnType<typeof appWindow>[], locks?: string[]) {
  const listeners = new Map<string, Listener>();
  const opened: string[] = [];
  // A tap lets the worker focus a window or open one, once: Chromium refuses the second ("Not allowed to open a window").
  let interaction = true;
  const interact = () => {
    if (!interaction) throw new DOMException("Not allowed to open a window.", "InvalidAccessError");
    interaction = false;
  };
  for (const window of windows) window.interact = interact;
  vi.stubGlobal("__SW_BUILD__", "test");
  vi.stubGlobal("__SW_PRECACHE__", ["/"]);
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/push/default/` },
    ...(locks && { navigator: { locks: { query: async () => ({ held: locks.map((name, at) => ({ name, clientId: `lock-${at}`, mode: "exclusive" })) }) } } }),
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { interact(); opened.push(url); return null; },
    },
    addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
  });
  vi.resetModules();
  await import("../../../../web/src/sw/sw");
  /** The tap on a notice of `profile` for `path`, until the worker is done with it; its waits for windows pass at once. */
  const tap = async (path: string, profile: string) => {
    let work: Promise<unknown> = Promise.resolve();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      listeners.get("notificationclick")!({ notification: { data: { path, profile }, close: () => {} }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
      let done = false;
      void work.finally(() => { done = true; });
      // A window's answer on its port is a task of its own: each step lets those in before the next wait runs out.
      while (!done) {
        await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(50);
      }
      await work;
    } finally {
      vi.useRealTimers();
    }
  };
  return { tap, opened };
}

const openChat = (path: string, profile: string): FromWorker => ({ type: "open-chat", path, profile });
/** Told to a window that said nothing: the worker only guessed it runs the profile. */
const guessed = (path: string, profile: string): FromWorker => ({ type: "open-chat", path, profile, silent: true });

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const profile of ["", "abc1234567"]) await clearWakeEntries(profile);
});

describe("a tap on a wake-up notification", () => {
  it("one window of the app, running the profile: it comes forward on the chat", async () => {
    const tab = appWindow("tab", { profile: "", peer: true });
    const { tap, opened } = await startPushWorker([tab]);
    await tap("/chat/abc", "");
    expect(tab.told).toEqual([openChat("/chat/abc", "")]);
    expect(tab.focusedByTap).toBe(true);
    expect(opened).toEqual([]);
  });

  it("goes to the tab that runs the profile, not to the one waiting behind it, even when that one is in front", async () => {
    const waiting = appWindow("waiting", { profile: "", peer: false }, { focused: true, visibilityState: "visible" });
    const running = appWindow("running", { profile: "", peer: true });
    const { tap, opened } = await startPushWorker([waiting, running]);
    await tap("/chat/abc", "");
    expect(running.told).toEqual([openChat("/chat/abc", "")]);
    expect(running.focusedByTap).toBe(true);
    expect(waiting.told).toEqual([]);
    expect(waiting.focusedByTap).toBe(false);
    expect(opened).toEqual([]);
  });

  it("goes to the window of the notice's profile: another profile's window, newest or in front, is left as it is", async () => {
    const work = appWindow("work", { profile: "work1", peer: true }, { focused: true, visibilityState: "visible" });
    const personal = appWindow("personal", { profile: "", peer: true });
    const { tap, opened } = await startPushWorker([work, personal]);
    await tap("/chat/abc", "");
    expect(personal.told).toEqual([openChat("/chat/abc", "")]);
    expect(personal.focusedByTap).toBe(true);
    expect(work.told).toEqual([]);
    expect(work.focusedByTap).toBe(false);
    expect(opened).toEqual([]);
  });

  it("no window runs the notice's profile: a new window opens on the chat, and the other profile's keeps running", async () => {
    const work = appWindow("work", { profile: "work1", peer: true }, { focused: true, visibilityState: "visible" });
    const { tap, opened } = await startPushWorker([work]);
    await tap("/chat/abc", "");
    expect(opened).toEqual(["/#/chat/abc"]);
    expect(work.told).toEqual([]);
    expect(work.focusedByTap).toBe(false);
  });

  it.each([1, 2, 3])("the profile's own window says nothing in time (frozen or busy) while another profile's answers: the silent one gets the chat, no new window (run %i)", async () => {
    const work = appWindow("work", { profile: "work1", peer: true }, { focused: true, visibilityState: "visible" });
    const frozen = appWindow("frozen", undefined, { takes: true });
    const { tap, opened } = await startPushWorker([work, frozen]);
    await tap("/chat/abc", "");
    expect(frozen.told).toEqual([guessed("/chat/abc", "")]);
    expect(frozen.focusedByTap).toBe(true);
    expect(work.told).toEqual([]);
    expect(work.focusedByTap).toBe(false);
    expect(opened).toEqual([]);
  });

  it.each([1, 2, 3])("the window that said nothing is another profile's frozen tab: it hands the chat back, and a new window opens on it (run %i)", async () => {
    const work = appWindow("work", { profile: "work1", peer: true }, { focused: true, visibilityState: "visible" });
    const frozen = appWindow("frozen", undefined, { takes: false });
    const { tap, opened } = await startPushWorker([work, frozen]);
    await tap("/chat/abc", "");
    expect(frozen.told).toEqual([guessed("/chat/abc", "")]);
    expect(work.told).toEqual([]);
    expect(opened).toEqual(["/#/chat/abc"]);
  });

  it("another profile's tab on screen was busy when tapped: it hands the chat back, and a new window opens on it rather than it coming forward", async () => {
    const busy = appWindow("busy", undefined, { focused: true, visibilityState: "visible", takes: false });
    const { tap, opened } = await startPushWorker([busy]);
    await tap("/chat/abc", "");
    expect(busy.told).toEqual([guessed("/chat/abc", "")]);
    expect(busy.focusedByTap).toBe(false);
    expect(opened).toEqual(["/#/chat/abc"]);
  });

  it("the profile's own tab is frozen (hidden, it answers nothing until focused): the tap focuses it, and it takes the chat", async () => {
    const frozen = appWindow("frozen", undefined, { takes: true, frozen: true });
    const { tap, opened } = await startPushWorker([frozen]);
    await tap("/chat/abc", "");
    expect(frozen.focusedByTap).toBe(true);
    expect(frozen.told).toEqual([guessed("/chat/abc", "")]);
    expect(opened).toEqual([]);
  });

  it.each([1, 2, 3])("the only window that says nothing is another profile's frozen tab, and nobody holds the notice's profile's peer lock: a new window opens on the chat, the frozen tab is left as it is (run %i)", async () => {
    await writeWakeText("", { title: "Ghostly", body: "New message", db: "ghostly" });
    const frozen = appWindow("frozen", undefined, { takes: false, frozen: true });
    const { tap, opened } = await startPushWorker([frozen], ["ghostly-peer-work1"]);
    await tap("/chat/abc", "");
    expect(opened).toEqual(["/#/chat/abc"]);
    expect(frozen.focusedByTap).toBe(false);
    expect(frozen.told).toEqual([]);
  });

  it("the profile's own frozen tab holds its peer lock: the tap focuses it, as before", async () => {
    await writeWakeText("", { title: "Ghostly", body: "New message", db: "ghostly" });
    const frozen = appWindow("frozen", undefined, { takes: true, frozen: true });
    const { tap, opened } = await startPushWorker([frozen], ["ghostly-peer"]);
    await tap("/chat/abc", "");
    expect(frozen.focusedByTap).toBe(true);
    expect(frozen.told).toEqual([guessed("/chat/abc", "")]);
    expect(opened).toEqual([]);
  });

  it("the lock is the one of the namespace the profile's page wrote (a handoff moved it), never another profile's", async () => {
    await writeWakeText("abc1234567", { title: "Ghostly", body: "New message", db: "ghostly_k3p" });
    const own = appWindow("own", undefined, { takes: true, frozen: true });
    const { tap, opened } = await startPushWorker([own], ["ghostly-peer-k3p"]);
    await tap("/chat/abc", "abc1234567");
    expect(own.focusedByTap).toBe(true);
    expect(opened).toEqual([]);

    const other = appWindow("other", undefined, { takes: false, frozen: true });
    const again = await startPushWorker([other], ["ghostly-peer", "ghostly-peer-abc1234567"]);
    await again.tap("/chat/abc", "abc1234567");
    expect(other.focusedByTap).toBe(false);
    expect(again.opened).toEqual(["/#/chat/abc"]);
  });

  it("a browser without Web Locks in its workers: the window that says nothing gets the tap, as before (another profile's frozen tab then only comes forward)", async () => {
    await writeWakeText("", { title: "Ghostly", body: "New message", db: "ghostly" });
    const frozen = appWindow("frozen", undefined, { takes: false, frozen: true });
    const { tap, opened } = await startPushWorker([frozen]);
    await tap("/chat/abc", "");
    expect(frozen.focusedByTap).toBe(true);
    expect(opened).toEqual([]);
  });

  it("no window of the app at all: a new one opens on the chat", async () => {
    const { tap, opened } = await startPushWorker([]);
    await tap("/chat/abc", "");
    expect(opened).toEqual(["/#/chat/abc"]);
  });

  it("windows that never say what they run (a page of the build before): the first one, as before", async () => {
    const old = appWindow("old");
    const other = appWindow("other");
    const { tap, opened } = await startPushWorker([old, other]);
    await tap("/chat/abc", "");
    // Nor does it answer the chat: it is left with it, and no second window opens.
    expect(old.told).toEqual([guessed("/chat/abc", "")]);
    expect(other.told).toEqual([]);
    expect(opened).toEqual([]);
  });
});
