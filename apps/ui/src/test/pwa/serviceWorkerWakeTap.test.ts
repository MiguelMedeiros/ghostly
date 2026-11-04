import { afterEach, describe, expect, it, vi } from "vitest";
import type { FromWorker } from "../../../../web/src/sw/messages";

// covers: push.wake.notify

/**
 * A tap on a wake-up notification, through the push worker's own script (`apps/web/src/sw/sw.ts`) in a stand-in scope:
 * which window of the app is brought forward and told to open the chat. Two windows are common (the installed app and
 * a tab, or two profiles side by side): the tap goes to the one that runs the notice's profile, never to a tab waiting
 * behind another or to another profile's window, which would switch away from the profile it runs.
 */
const ORIGIN = "https://app.ghostly.tools";

type Listener = (event: object) => void;

/** A window of the app. `says` is what its page answers when asked what it runs; undefined: it never answers (an older build). */
function appWindow(id: string, says?: { profile: string; peer: boolean }, extra: { focused?: boolean; visibilityState?: string } = {}) {
  const told: FromWorker[] = [];
  const window = {
    id, url: `${ORIGIN}/#/`, focused: false, visibilityState: "hidden", ...extra, told, focusedByTap: false,
    postMessage(message: FromWorker, transfer?: MessagePort[]) {
      if (message.type === "open-ask") { if (says) transfer?.[0]?.postMessage(says); return; }
      told.push(message);
    },
    async focus() { window.focusedByTap = true; return window; },
  };
  return window;
}

async function startPushWorker(windows: ReturnType<typeof appWindow>[]) {
  const listeners = new Map<string, Listener>();
  const opened: string[] = [];
  vi.stubGlobal("__SW_BUILD__", "test");
  vi.stubGlobal("__SW_PRECACHE__", ["/"]);
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/push/default/` },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); return null; },
    },
    addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener); },
  });
  vi.resetModules();
  await import("../../../../web/src/sw/sw");
  /** The tap on a notice of `profile` for `path`, until the worker is done with it. */
  const tap = async (path: string, profile: string) => {
    let work: Promise<unknown> = Promise.resolve();
    listeners.get("notificationclick")!({ notification: { data: { path, profile }, close: () => {} }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  };
  return { tap, opened };
}

const openChat = (path: string, profile: string): FromWorker => ({ type: "open-chat", path, profile });

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(old.told).toEqual([openChat("/chat/abc", "")]);
    expect(other.told).toEqual([]);
    expect(opened).toEqual([]);
  });
});
