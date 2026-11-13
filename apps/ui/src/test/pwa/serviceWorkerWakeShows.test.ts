import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWakeEntries } from "../../../../web/src/sw/wakeStore";
import { resetWakeLimitMemory } from "../../../../web/src/sw/wakeLimit";
import { OPEN_ASK_MS, type FromWorker } from "../../../../web/src/sw/messages";

// covers: push.wake.notify, push.wake.call, push.wake.online

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
const GROUP = "tok-group-aaaaaaaaaaaa";
// The worker's limit is kept in IndexedDB for the whole file: each online test has a chat of its own.
const ANA = "tok-ana-aaaaaaaaaaaaaa";
const BEA = "tok-bea-aaaaaaaaaaaaaa";
const CAI = "tok-cai-aaaaaaaaaaaaaa";
const DAN = "tok-dan-aaaaaaaaaaaaaa";
const EVE = "tok-eve-aaaaaaaaaaaaaa";
const FAY = "tok-fay-aaaaaaaaaaaaaa";
const TEXT = { title: "Ghostly", body: "New message", call: "Incoming call", online: "{name} is online", onlineUnnamed: "A contact is online" };

interface Shown { title: string; options: { tag?: string; silent?: boolean; body?: string; renotify?: boolean; vibrate?: number[] }; closed: boolean }

/**
 * A window of the app, in front unless `extra` says otherwise. `says` is what its page answers when asked what it runs
 * (`open-ask`); undefined: it never answers (a page of an older build, or busy).
 */
function appWindow(id: string, says?: { profile: string; peer: boolean }, extra: { focused?: boolean; visibilityState?: string } = {}) {
  const asked: number[] = [];
  return {
    id, url: `${ORIGIN}/`, focused: true, visibilityState: "visible", ...extra, asked,
    postMessage(message: FromWorker, transfer?: MessagePort[]) {
      if (message.type !== "open-ask") return;
      asked.push(Date.now());
      if (says) transfer?.[0]?.postMessage(says);
    },
  };
}

async function startPushWorker(windows: ReturnType<typeof appWindow>[] = []) {
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
  await writeWakeEntries("", [
    { token: TOKEN, path: "/chat/abc" }, { token: MUTED, path: "/chat/quiet", mutedUntil: "forever" }, { token: GROUP, path: "/group/g1" },
    { token: ANA, path: "/chat/ana", name: "Ana" }, { token: BEA, path: "/chat/bea", name: "Bea" },
    { token: CAI, path: "/chat/cai", name: "Cai" }, { token: DAN, path: "/chat/dan", name: "Dan" },
    { token: EVE, path: "/chat/eve" },
  ], TEXT);
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
    const { push, onScreen, shown } = await startPushWorker([appWindow("app", { profile: "", peer: true })]);
    expect(await push(wake(TOKEN))).toBe(1);
    expect(await push(wake(TOKEN, { c: 1 }))).toBe(1);
    expect(await push(wake(ANA, { o: 1 }))).toBe(1);
    expect(await push(wake("tok-nobody-knows-aaaaaa"))).toBe(1);
    expect(shown.every((notice) => notice.options.tag === "quiet:" && notice.options.silent === true)).toBe(true);
    expect(onScreen()).toHaveLength(0);
  });

  it("a window in front that does not say what it runs (an older build, or busy) still counts as the app on screen, after at most the wait for its answer", async () => {
    const silent = appWindow("old");
    const { push, onScreen } = await startPushWorker([silent]);
    const started = Date.now();
    expect(await push(wake(TOKEN))).toBe(1);
    expect(Date.now() - started).toBeLessThan(OPEN_ASK_MS + 400);
    expect(silent.asked).toHaveLength(1);
    expect(onScreen()).toHaveLength(0);
  });

  it("another profile's window on screen: a message, a call and an online wake-up of this profile show their own notice, with sound", async () => {
    // Profile "" is woken while the window in front runs profile "work1" (and its peer): "" runs nowhere on screen.
    const other = appWindow("work1", { profile: "work1", peer: true });
    const { push, shown, onScreen } = await startPushWorker([other, appWindow("bg", { profile: "", peer: true }, { focused: false, visibilityState: "hidden" })]);
    expect(await push(wake(CAI))).toBe(1);
    expect(shown[0]).toMatchObject({ options: { tag: "wake::/chat/cai", body: "New message" }, closed: false });
    expect(shown[0]!.options.silent).toBeUndefined();
    expect(await push(wake(CAI, { c: 1 }))).toBe(1);
    expect(shown[1]).toMatchObject({ options: { tag: "wake-call::/chat/cai", body: "Incoming call", renotify: true }, closed: false });
    expect(shown[1]!.options.silent).toBeUndefined();
    expect(shown[1]!.options.vibrate?.length).toBeGreaterThan(0);
    expect(await push(wake(DAN, { o: 1 }))).toBe(1);
    expect(shown[2]).toMatchObject({ options: { tag: "wake-online::/chat/dan", body: "Dan is online" }, closed: false });
    expect(shown[2]!.options.silent).toBeUndefined();
    expect(onScreen().map((notice) => notice.options.tag)).toEqual(["wake::/chat/cai", "wake-call::/chat/cai", "wake-online::/chat/dan"]);
    // Only the window in front is asked what it runs.
    expect(other.asked).toHaveLength(3);
  });

  it("a tab of this profile waiting behind another (it does not hold the peer) is not the app on screen either", async () => {
    const { push, shown } = await startPushWorker([appWindow("waiting", { profile: "", peer: false })]);
    expect(await push(wake(EVE))).toBe(1);
    expect(shown[0]).toMatchObject({ options: { tag: "wake::/chat/eve", body: "New message" }, closed: false });
  });

  it("with this profile's window and another profile's both on screen, this profile's app is on screen", async () => {
    const { push, onScreen } = await startPushWorker([appWindow("work1", { profile: "work1", peer: true }), appWindow("app", { profile: "", peer: true })]);
    expect(await push(wake(TOKEN))).toBe(1);
    expect(onScreen()).toHaveLength(0);
  });

  it("an online notice shows under its own tag; one with nothing of its own to say (an unknown token, a muted chat, a group) shows the quiet notice", async () => {
    const { push, shown } = await startPushWorker();
    expect(await push(wake(ANA, { o: 1 }))).toBe(1);
    expect(shown[0]).toMatchObject({ options: { body: "Ana is online", tag: "wake-online::/chat/ana" } });
    expect(shown[0]!.options.silent).toBeUndefined();
    for (const body of [wake("tok-nobody-knows-aaaaaa", { o: 1 }), wake(MUTED, { o: 1 }), wake(GROUP, { o: 1 })]) {
      const before = shown.length;
      expect(await push(body), body).toBe(1);
      expect(shown[before]).toMatchObject({ options: { tag: "quiet:", body: "", silent: true } });
    }
  });

  it("with online notices turned off on this device, an online push shows the quiet notice, never \"<name> is online\"; a message still shows", async () => {
    await writeWakeEntries("", [{ token: FAY, path: "/chat/fay", name: "Fay" }], { ...TEXT, onlineOff: true });
    const { push, shown } = await startPushWorker();
    expect(await push(wake(FAY, { o: 1 }))).toBe(1);
    expect(shown[0]).toMatchObject({ options: { tag: "quiet:", body: "", silent: true } });
    expect(await push(wake(FAY))).toBe(1);
    expect(shown[1]).toMatchObject({ options: { body: "New message", tag: "wake::/chat/fay" } });
  });

  it("an online notice inside its 30-minute gap: the one on screen again, silently, or the quiet notice once it was dismissed", async () => {
    const { push, shown, onScreen } = await startPushWorker();
    expect(await push(wake(BEA, { o: 1 }))).toBe(1);
    expect(shown[0]).toMatchObject({ options: { body: "Bea is online", tag: "wake-online::/chat/bea" } });
    expect(await push(wake(BEA, { o: 1 }))).toBe(1);
    expect(shown[1]).toMatchObject({ options: { tag: "wake-online::/chat/bea", silent: true } });
    for (const notice of shown) notice.closed = true;
    expect(await push(wake(BEA, { o: 1 }))).toBe(1);
    expect(shown[2]).toMatchObject({ options: { tag: "quiet:", silent: true } });
    expect(onScreen()).toHaveLength(1);
    // Its own count: a message from the same chat still shows, with sound.
    expect(await push(wake(BEA))).toBe(1);
    expect(shown[3]).toMatchObject({ options: { body: "New message" } });
    expect(shown[3]!.options.silent).toBeUndefined();
  });
});
