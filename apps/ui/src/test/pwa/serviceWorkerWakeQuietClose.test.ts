import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWakeEntries } from "../../../../web/src/sw/wakeStore";
import { resetWakeLimitMemory } from "../../../../web/src/sw/wakeLimit";

// covers: push.wake.notify, push.wake.call, push.wake.online

/**
 * The quiet notice a push with nothing to say leaves (an empty "Ghostly") used to stay beside the real wake-up that
 * came after it, under another tag, and both stayed after the app was opened. A notice of the profile that says
 * something now closes the quiet one, so the system's list holds only the notice that tells. The real push worker
 * script (`apps/web/src/sw/sw.ts`) under a stub of the worker's scope.
 */
const ORIGIN = "https://app.ghostly.tools";
// The worker's limit is kept in IndexedDB for the whole file: each test has chats of its own.
const MSG = "tok-msg-aaaaaaaaaaaaaa";
const CALL = "tok-call-aaaaaaaaaaaaa";
const ONLINE = "tok-online-aaaaaaaaaaa";
const AGAIN = "tok-again-aaaaaaaaaaaa";
const OTHER = "tok-other-aaaaaaaaaaaa";
const FRESH = "tok-fresh-aaaaaaaaaaaa";
const TEXT = { title: "Ghostly", body: "New message", call: "Incoming call", online: "{name} is online", onlineUnnamed: "A contact is online" };

interface Shown { title: string; options: { tag?: string; silent?: boolean; body?: string }; closed: boolean }

async function startPushWorker() {
  const listeners = new Map<string, (event: object) => void>();
  const shown: Shown[] = [];
  const onScreen = () => {
    const byTag = new Map<string, Shown>();
    for (const notice of shown) if (!notice.closed) byTag.set(notice.options.tag ?? "", notice);
    return [...byTag.values()];
  };
  vi.stubGlobal("__SW_BUILD__", "test");
  vi.stubGlobal("__SW_PRECACHE__", ["/"]);
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: {
      scope: `${ORIGIN}/push/default/`,
      async showNotification(title: string, options: Shown["options"]) {
        for (const notice of shown) if (notice.options.tag === options.tag) notice.closed = true;
        shown.push({ title, options, closed: false });
      },
      async getNotifications(filter?: { tag?: string }) {
        return onScreen().filter((notice) => !filter?.tag || notice.options.tag === filter.tag).map((notice) => ({ data: null, close: () => { notice.closed = true; } }));
      },
    },
    clients: { matchAll: async () => [], openWindow: async () => null },
    addEventListener: (type: string, listener: (event: object) => void) => { listeners.set(type, listener); },
  });
  vi.resetModules();
  await import("../../../../web/src/sw/sw");
  /** One push with this body, until the worker is done with it; how many notices it asked the browser to show. */
  const push = async (body: string | null) => {
    const before = shown.length;
    let work: Promise<unknown> = Promise.resolve();
    listeners.get("push")!({ data: body === null ? null : { text: () => body }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
    return shown.length - before;
  };
  const tags = () => onScreen().map((notice) => notice.options.tag);
  return { push, shown, tags };
}

const wake = (token: string, extra: object = {}) => JSON.stringify({ wake: 1, k: token, ...extra });
const JUNK = wake("tok-nobody-knows-aaaaaa");

beforeEach(async () => {
  await writeWakeEntries("", [
    { token: MSG, path: "/chat/abc" }, { token: CALL, path: "/chat/call" }, { token: ONLINE, path: "/chat/ana", name: "Ana" },
    { token: AGAIN, path: "/chat/again" }, { token: OTHER, path: "/chat/other" }, { token: FRESH, path: "/chat/fresh" },
  ], TEXT);
});

afterEach(() => {
  resetWakeLimitMemory();
  vi.unstubAllGlobals();
});

describe("a notice that says something closes the profile's quiet one", () => {
  it("a push with nothing to say, then a real wake-up: only the real one stays", async () => {
    const { push, tags } = await startPushWorker();
    expect(await push(JUNK)).toBe(1);
    expect(tags()).toEqual(["quiet:"]);
    expect(await push(wake(MSG))).toBe(1);
    expect(tags()).toEqual(["wake::/chat/abc"]);
  });

  it("a call and an online notice close it too; every push still shows a notice", async () => {
    const { push, tags } = await startPushWorker();
    expect(await push(JUNK)).toBe(1);
    expect(await push(wake(CALL, { c: 1 }))).toBe(1);
    expect(tags()).toEqual(["wake-call::/chat/call"]);
    expect(await push(JUNK)).toBe(1);
    expect(tags()).toEqual(["wake-call::/chat/call", "quiet:"]);
    expect(await push(wake(ONLINE, { o: 1 }))).toBe(1);
    expect(tags()).toEqual(["wake-call::/chat/call", "wake-online::/chat/ana"]);
  });

  it("a wake-up inside its gap, shown again silently, closes a quiet one that came between", async () => {
    const { push, shown, tags } = await startPushWorker();
    expect(await push(wake(AGAIN))).toBe(1);
    expect(await push(JUNK)).toBe(1);
    expect(tags()).toEqual(["wake::/chat/again", "quiet:"]);
    expect(await push(wake(AGAIN))).toBe(1);
    expect(shown[shown.length - 1]).toMatchObject({ options: { tag: "wake::/chat/again", silent: true } });
    expect(tags()).toEqual(["wake::/chat/again"]);
  });

  it("closes nothing else: another chat's notice stays", async () => {
    const { push, tags } = await startPushWorker();
    expect(await push(wake(OTHER))).toBe(1);
    expect(await push(JUNK)).toBe(1);
    expect(await push(wake(FRESH))).toBe(1);
    expect(tags()).toEqual(["wake::/chat/other", "wake::/chat/fresh"]);
  });
});
