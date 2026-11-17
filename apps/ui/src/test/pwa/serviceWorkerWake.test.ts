import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeWakeEntries, clearWakeEntries, writeWakeText, readWakeEntry, readWakeText } from "../../../../web/src/sw/wakeStore";
import { resetWakeLimitMemory, takeWakeSlot } from "../../../../web/src/sw/wakeLimit";
import { OPEN_ASK_MS, type FromWorker } from "../../../../web/src/sw/messages";
import { WAKE_NOTICE_GAP_MS, wakeNoticeDue, DEVICE_NOTICE_DEFAULTS, pushNotice, type NoticeDevice } from "../../../../web/src/sw/policy";
import { unsubscribePush } from "../../../../web/src/pwa/push";
import { pushDeviceView, readPushDeviceView } from "../../../../web/src/sw/deviceState";

// covers: push.wake.notify, push.wake.call, push.wake.online
describe("every push the worker takes shows a notification", () => {
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

// covers: push.wake.notify
describe("a tap on a wake-up notification", () => {
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

// covers: push.wake.notify, push.wake.call, push.wake.online
describe("a notice that says something closes the profile's quiet one", () => {
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

// covers: push.wake.notify, push.wake.call, push.wake.online
describe("the worker's limit on wake-ups", () => {
  /**
   * The push worker's own limit on wake-ups (apps/web/src/sw/sw.ts): a contact's app keeps to one wake-up per 5 minutes,
   * but one that does not could fill the screen with "Incoming call" notices that stay until dismissed. Per token,
   * at most one call notice per 30 s and one message notice per 5 minutes; what was shown last survives the worker
   * being stopped between pushes.
   */
  const T0 = 1_800_000_000_000;

  afterEach(() => {
    resetWakeLimitMemory();
    vi.unstubAllGlobals();
  });

  describe("when a wake-up may show", () => {
    it("the first one always; then one call per 30 s and one message per 5 minutes", () => {
      expect(WAKE_NOTICE_GAP_MS).toEqual({ call: 30_000, message: 300_000, online: 1_800_000 });
      expect(wakeNoticeDue(T0, "online", T0 + 1_799_999)).toBe(false);
      expect(wakeNoticeDue(T0, "online", T0 + 1_800_000)).toBe(true);
      expect(wakeNoticeDue(undefined, true, T0)).toBe(true);
      expect(wakeNoticeDue(T0, true, T0 + 29_999)).toBe(false);
      expect(wakeNoticeDue(T0, true, T0 + 30_000)).toBe(true);
      expect(wakeNoticeDue(T0, false, T0 + 299_999)).toBe(false);
      expect(wakeNoticeDue(T0, false, T0 + 300_000)).toBe(true);
      // A clock set back does not silence a token for good.
      expect(wakeNoticeDue(T0 + 60_000, true, T0)).toBe(true);
    });
  });

  describe("the worker's record of what it showed", () => {
    it("lets a flood of call wake-ups from one token through once per 30 s", async () => {
      const shown: number[] = [];
      for (let second = 0; second < 90; second++) {
        if (await takeWakeSlot("", "tok-flood", true, T0 + second * 1000)) shown.push(second);
      }
      expect(shown).toEqual([0, 30, 60]);
    });

    it("counts messages apart from calls, tokens apart, and profiles apart", async () => {
      expect(await takeWakeSlot("", "tok-a", true, T0)).toBe(true);
      expect(await takeWakeSlot("", "tok-a", false, T0 + 1)).toBe(true);
      expect(await takeWakeSlot("", "tok-a", false, T0 + 60_000)).toBe(false);
      expect(await takeWakeSlot("", "tok-b", false, T0 + 60_000)).toBe(true);
      expect(await takeWakeSlot("work", "tok-a", false, T0 + 60_000)).toBe(true);
      expect(await takeWakeSlot("", "tok-a", false, T0 + 300_001)).toBe(true);
    });

    it("counts online notices apart: one every 30 minutes, never taking a message's turn", async () => {
      expect(await takeWakeSlot("", "tok-o", "online", T0)).toBe(true);
      expect(await takeWakeSlot("", "tok-o", false, T0 + 1)).toBe(true);
      expect(await takeWakeSlot("", "tok-o", "online", T0 + 10 * 60_000)).toBe(false);
      expect(await takeWakeSlot("", "tok-o", "online", T0 + 30 * 60_000)).toBe(true);
    });

    it("keeps it in IndexedDB, so a worker started afresh still knows", async () => {
      expect(await takeWakeSlot("", "tok-kept", true, T0)).toBe(true);
      resetWakeLimitMemory();
      expect(await takeWakeSlot("", "tok-kept", true, T0 + 5_000)).toBe(false);
    });

    it("two pushes handled at once show one notice", async () => {
      const both = await Promise.all([takeWakeSlot("", "tok-race", true, T0), takeWakeSlot("", "tok-race", true, T0)]);
      expect(both.filter(Boolean)).toHaveLength(1);
    });

    it("falls back to memory when IndexedDB cannot be used", async () => {
      vi.stubGlobal("indexedDB", undefined);
      expect(await takeWakeSlot("", "tok-mem", true, T0)).toBe(true);
      expect(await takeWakeSlot("", "tok-mem", true, T0 + 1_000)).toBe(false);
      expect(await takeWakeSlot("", "tok-mem", true, T0 + 30_000)).toBe(true);
    });

    it("forgets a profile's tokens when it stops being woken (push off, profile deleted), and keeps another profile's", async () => {
      expect(await takeWakeSlot("gone", "tok-gone", true, T0)).toBe(true);
      expect(await takeWakeSlot("kept", "tok-kept2", true, T0)).toBe(true);
      await unsubscribePush("gone");
      // A worker started afresh: only IndexedDB remembers.
      resetWakeLimitMemory();
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly-wake-limit", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const keys = await new Promise<IDBValidKey[]>((resolve) => { const r = db.transaction("shown").objectStore("shown").getAllKeys(); r.onsuccess = () => resolve(r.result); });
      db.close();
      expect(keys.filter((key) => String(key).startsWith("gone|"))).toEqual([]);
      expect(keys).toContain("kept|tok-kept2|call");
      expect(await takeWakeSlot("kept", "tok-kept2", true, T0 + 5_000)).toBe(false);
    });

    it("does not keep the rows of tokens that no longer limit anything (a chat muted or deleted gets a new token)", async () => {
      const DAY = 24 * 60 * 60_000;
      for (let era = 0; era < 20; era++) {
        for (let chat = 0; chat < 5; chat++) {
          expect(await takeWakeSlot("rot", `tok-${era}-${chat}`, false, T0 + era * DAY)).toBe(true);
          expect(await takeWakeSlot("rot", `tok-${era}-${chat}`, "online", T0 + era * DAY)).toBe(true);
        }
      }
      resetWakeLimitMemory();
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("ghostly-wake-limit", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const keys = await new Promise<IDBValidKey[]>((resolve) => { const r = db.transaction("shown").objectStore("shown").getAllKeys(); r.onsuccess = () => resolve(r.result); });
      db.close();
      // Only the last era's rows: every older one is past the longest gap.
      expect(keys.filter((key) => String(key).startsWith("rot|")).sort()).toEqual(
        Array.from({ length: 5 }, (_, chat) => [`rot|tok-19-${chat}|message`, `rot|tok-19-${chat}|online`]).flat().sort(),
      );
      // And the rows kept still hold: the same chat is not shown again inside its gap.
      expect(await takeWakeSlot("rot", "tok-19-0", false, T0 + 19 * DAY + 60_000)).toBe(false);
      expect(await takeWakeSlot("rot", "tok-19-0", "online", T0 + 19 * DAY + 10 * 60_000)).toBe(false);
    });

    it("keeps the row it takes when that token's own row was spent", async () => {
      expect(await takeWakeSlot("own", "tok-own", false, T0)).toBe(true);
      expect(await takeWakeSlot("own", "tok-own", false, T0 + 31 * 60_000)).toBe(true);
      expect(await takeWakeSlot("own", "tok-own", false, T0 + 31 * 60_000 + 1_000)).toBe(false);
    });

    it("drops spent rows from the memory fallback too", async () => {
      vi.stubGlobal("indexedDB", undefined);
      resetWakeLimitMemory();
      expect(await takeWakeSlot("", "tok-old", true, T0)).toBe(true);
      expect(await takeWakeSlot("", "tok-new", true, T0 + 31 * 60_000)).toBe(true);
      // tok-old's row went when tok-new took its slot: read with the clock set back, it is not there to hold a call back.
      expect(await takeWakeSlot("", "tok-old", true, T0 + 1_000)).toBe(true);
    });
  });
});

// covers: devices.push, devices.push.wake, devices.push.renew
describe("a push on a device on standby", () => {
  /*
   * What the push worker shows in a profile on several devices (WISP 06 § Push and the phone), the rules of
   * `apps/web/src/sw/policy.ts` and the worker's own read of the device state (`deviceState.ts`): a device that is not the
   * active one never rings and never shows a message, and a wake-up from another of the person's devices names it, only
   * for a token this device gave one of its own.
   */

  const now = 1_800_000_000_000;
  const TOKEN = "t".repeat(22), DEVICE_TOKEN = "d".repeat(22);
  const chat = { entry: { path: "/chat/abc" }, text: { title: "Ghostly", body: "New message", call: "Incoming call" } };
  const standby: NoticeDevice = { state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } };
  const active: NoticeDevice = { state: "active", tokens: { [DEVICE_TOKEN]: "Phone" } };
  const options = { now, appVisible: false, profile: "" };

  describe("a push on a device that is not the active one", () => {
    it("a message and a call show the quiet standby notice, naming the active device, and open the standby screen", () => {
      const message = pushNotice({ token: TOKEN, kind: "message" }, chat, standby, options);
      expect(message).toEqual({ title: "Ghostly", body: "New message. Active on MacBook.", tag: "standby:", call: false, quiet: true, data: { path: "/", profile: "" } });
      const call = pushNotice({ token: TOKEN, kind: "call" }, chat, standby, options);
      expect(call).toMatchObject({ body: "Call for you. Active on MacBook.", call: false, quiet: true });
    });

    it("an online notice shows nothing there: the person is on the active device", () => {
      expect(pushNotice({ token: TOKEN, kind: "online" }, chat, standby, options)).toBeNull();
      expect(pushNotice({ token: TOKEN, kind: "online" }, { entry: { path: "/chat/abc", name: "Ana" }, text: chat.text }, active, options)).toMatchObject({ body: "Ana is online" });
    });

    it("in the app's language when a page wrote its words, and without a name when the record names no other device", () => {
      const text = { title: "Ghostly", standby: "Nova mensagem. Ativo em {device}.", standbyCallUnnamed: "Chamada para você. Abra o Ghostly no seu dispositivo ativo." };
      expect(pushNotice({ token: TOKEN, kind: "message" }, chat, standby, { ...options, text })!.body).toBe("Nova mensagem. Ativo em MacBook.");
      expect(pushNotice({ token: TOKEN, kind: "call" }, chat, { state: "moving", tokens: {} }, { ...options, text })!.body).toBe("Chamada para você. Abra o Ghostly no seu dispositivo ativo.");
      expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, { state: "superseded", tokens: {} }, options)!.body).toBe(DEVICE_NOTICE_DEFAULTS.standbyUnnamed);
    });

    it("a token this device never knew still shows it (a chat made on the active device); a muted chat, a removed device or an open app shows nothing", () => {
      expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, standby, options)).toMatchObject({ quiet: true });
      expect(pushNotice({ token: TOKEN, kind: "message" }, { ...chat, entry: { path: "/chat/abc", mutedUntil: "forever" } }, standby, options)).toBeNull();
      expect(pushNotice({ token: TOKEN, kind: "message" }, { ...chat, entry: { path: "/chat/abc", mutedUntil: now + 1 } }, standby, options)).toBeNull();
      expect(pushNotice({ token: TOKEN, kind: "message" }, chat, { state: "removed", tokens: {} }, options)).toBeNull();
      expect(pushNotice({ token: TOKEN, kind: "message" }, chat, standby, { ...options, appVisible: true })).toBeNull();
    });

    it("once the active device listed the chats' tokens it hands out, only those show: a chat deleted or muted there stays quiet here", () => {
      const told: NoticeDevice = { ...standby, allowed: [TOKEN] };
      expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, told, options)).toMatchObject({ quiet: true });
      expect(pushNotice({ token: "deletedchataaaaaaaaaaa", kind: "message" }, undefined, told, options)).toBeNull();
      expect(pushNotice({ token: "deletedchataaaaaaaaaaa", kind: "call" }, undefined, told, options)).toBeNull();
      // A wake-up from one of the person's devices is not a chat's: the list does not apply to it.
      expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, told, options)).not.toBeNull();
    });

    it("a state that cannot be read is no license to ring: quiet too", () => {
      expect(pushNotice({ token: TOKEN, kind: "call" }, chat, { state: "unreadable", tokens: {} }, options)).toMatchObject({ quiet: true, call: false });
    });
  });

  describe("a push on the active device, or in a profile on one device", () => {
    it("shows today's notices, ringing for a call", () => {
      expect(pushNotice({ token: TOKEN, kind: "call" }, chat, active, options)).toMatchObject({ body: "Incoming call", call: true });
      expect(pushNotice({ token: TOKEN, kind: "call" }, chat, null, options)).toMatchObject({ body: "Incoming call", call: true });
      expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, null, options)).toBeNull();
      expect(pushNotice({ token: TOKEN, kind: "message" }, chat, active, options)!.quiet).toBeUndefined();
    });
  });

  describe("a wake-up from another of the person's devices", () => {
    it("names the device whose token it carries: take over where this one is active, move here where it is not", () => {
      expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, active, options)).toEqual({ title: "Ghostly", body: "Phone wants to take over. Open Ghostly.", tag: "device:", call: false, data: { path: "/", profile: "" } });
      expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, standby, options)!.body).toBe("MacBook wants to move this profile here. Open Ghostly.");
    });

    it("shows nothing for a token no device of this one holds, a contact's chat token included, nor in a profile on one device", () => {
      expect(pushNotice({ token: TOKEN, kind: "device" }, chat, active, options)).toBeNull();
      expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, null, options)).toBeNull();
      expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, active, { ...options, appVisible: true })).toBeNull();
    });

    it("shows nothing for a token that names what every object has, whatever the device set looks like", () => {
      const inherited = Object.getOwnPropertyNames(Object.prototype).filter((name) => /^[A-Za-z0-9_-]{16,64}$/.test(name));
      expect(inherited).toContain("__defineGetter__");
      const view = pushDeviceView({ state: "standby", activeSlot: 0, ownSlot: 1, deviceSet: [{ key: "K".repeat(43), name: "MacBook" }], push: { own: { tokens: { ["K".repeat(43)]: DEVICE_TOKEN } } } })!;
      for (const token of inherited) {
        for (const device of [active, standby, view, { state: "removed", tokens: {} }]) expect(pushNotice({ token, kind: "device" }, undefined, device, options)).toBeNull();
      }
    });
  });

  describe("the worker's read of the device state", () => {
    const record = {
      v: 1, profile: "ghostly_abc", state: "standby", saved: 3, turn: 4, rev: 0, takeovers: 0, earlierSets: [], activeSlot: 0, ownSlot: 1,
      deviceSet: [{ key: "K".repeat(43), name: "MacBook" }, { key: "P".repeat(43), name: "Phone" }, null, null],
      push: { own: { e: "https://fcm.googleapis.com/x", p: "p", a: "a", vp: "v", vk: "k", tokens: { ["K".repeat(43)]: DEVICE_TOKEN, ["G".repeat(43)]: "g".repeat(22) } } },
    };

    it("takes out the state, the active device's name and whose each token is; a token of a device the set no longer lists names nobody", () => {
      expect(pushDeviceView(record)).toEqual({ state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } });
      expect(pushDeviceView({ ...record, state: "active", activeSlot: 1 })).toEqual({ state: "active", tokens: { [DEVICE_TOKEN]: "MacBook" } });
      expect(pushDeviceView(undefined)).toBeNull();
      expect(pushDeviceView({ ...record, push: { ...record.push, allowed: [TOKEN] } })).toMatchObject({ allowed: [TOKEN] });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase("ghostly-devices"); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
    });

    it("never makes the database: none there is a profile on one device", async () => {
      expect(await readPushDeviceView("ghostly_abc")).toBeNull();
      expect((await indexedDB.databases()).map((db) => db.name)).not.toContain("ghostly-devices");
      expect(await readPushDeviceView(undefined)).toBeNull();
    });

    it("reads the profile's record by its database's name", async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("ghostly-devices", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "profile" });
        request.onsuccess = () => { const tx = request.result.transaction("devices", "readwrite"); tx.objectStore("devices").put(record); tx.oncomplete = () => { request.result.close(); resolve(); }; };
        request.onerror = () => reject(request.error);
      });
      expect(await readPushDeviceView("ghostly_abc")).toEqual({ state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } });
      // Another profile of this browser has no record: on one device.
      expect(await readPushDeviceView("ghostly_other")).toBeNull();
    });
  });

  describe("the words a standby's page writes", () => {
    it("leave the chats' tokens as the active page wrote them", async () => {
      await writeWakeEntries("p1", [{ token: TOKEN, path: "/chat/abc" }], { title: "Ghostly", body: "New message" });
      await writeWakeText("p1", { title: "Ghostly", body: "Nova mensagem", standby: "Nova mensagem. Ativo em {device}.", db: "ghostly_p1" });
      expect((await readWakeEntry("p1", TOKEN))?.entry).toEqual({ token: TOKEN, path: "/chat/abc" });
      expect(await readWakeText("p1")).toMatchObject({ db: "ghostly_p1", standby: "Nova mensagem. Ativo em {device}." });
    });
  });
});
