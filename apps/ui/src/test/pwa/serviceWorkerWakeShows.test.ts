import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWakeEntries } from "../../../../web/src/sw/wakeStore";
import { resetWakeLimitMemory } from "../../../../web/src/sw/wakeLimit";

// covers: push.wake.notify, push.wake.call

/**
 * Every push the profile's push worker (`apps/web/src/sw/sw.ts`) takes shows a notification. A push that shows nothing
 * counts against the subscription in the browsers wake-ups are for (Safari ends it after a few, Firefox after its
 * quota), and then no contact can wake the app until it is opened again. So a push with nothing of its own to show (not
 * a wake-up, a token this profile does not know, a muted chat, one inside the gap after the last notice was dismissed)
 * shows one quiet notice of the profile, replaced in place: any number of them leave one notice on screen, silent.
 */
const ORIGIN = "https://app.ghostly.tools";
const TOKEN = "tok-known-aaaaaaaaaaaa";
const MUTED = "tok-muted-aaaaaaaaaaaa";
const TEXT = { title: "Ghostly", body: "New message", call: "Incoming call" };

interface Shown { title: string; options: { tag?: string; silent?: boolean; body?: string }; closed: boolean }

async function startPushWorker(appVisible = false) {
  const listeners = new Map<string, (event: object) => void>();
  const shown: Shown[] = [];
  const windows = appVisible ? [{ id: "app", url: `${ORIGIN}/`, focused: true, visibilityState: "visible", postMessage() {} }] : [];
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
    clients: { matchAll: async () => windows, openWindow: async () => null },
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
  return { push, shown, onScreen };
}

const wake = (token: string, extra: object = {}) => JSON.stringify({ wake: 1, k: token, ...extra });

beforeEach(async () => {
  await writeWakeEntries("", [{ token: TOKEN, path: "/chat/abc" }, { token: MUTED, path: "/chat/quiet", mutedUntil: "forever" }], TEXT);
});

afterEach(() => {
  resetWakeLimitMemory();
  vi.unstubAllGlobals();
});

describe("every push the worker takes shows a notification", () => {
  it("a push with nothing of its own to show: one quiet notice, never nothing", async () => {
    const { push, shown } = await startPushWorker();
    for (const body of [null, "", "not json", "{}", wake("short"), wake("tok-nobody-knows-aaaaaa"), wake("tok-nobody-knows-aaaaaa", { c: 1 }), wake("tok-nobody-knows-aaaaaa", { d: 1 }), wake(MUTED), wake(MUTED, { c: 1 })]) {
      expect(await push(body), String(body)).toBe(1);
    }
    expect(shown.every((notice) => notice.options.silent === true)).toBe(true);
  });

  it("many junk pushes leave one notice on screen, silent, replaced in place", async () => {
    const { push, onScreen } = await startPushWorker();
    for (let i = 0; i < 20; i++) await push(wake(`tok-junk-${String(i).padStart(12, "0")}`));
    expect(onScreen()).toHaveLength(1);
    expect(onScreen()[0]!.options.silent).toBe(true);
  });

  it("a wake-up inside the gap after its notice was dismissed still shows, quietly", async () => {
    const { push, onScreen, shown } = await startPushWorker();
    expect(await push(wake(TOKEN))).toBe(1);
    expect(shown[0]!.options.silent).toBeUndefined();
    for (const notice of shown) notice.closed = true;
    expect(await push(wake(TOKEN))).toBe(1);
    expect(shown[1]!.options.silent).toBe(true);
    expect(onScreen()).toHaveLength(1);
  });

  it("with the app on screen it shows one too, and takes it away at once", async () => {
    const { push, onScreen } = await startPushWorker(true);
    expect(await push(wake(TOKEN))).toBe(1);
    expect(await push(wake("tok-nobody-knows-aaaaaa"))).toBe(1);
    expect(onScreen()).toHaveLength(0);
  });
});
