import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAR_ORIGIN_MS, OPENED_KEY, forgetServices, noteOpened, openedServices } from "../../../../web/src/svc/forget";
import { clearSite, dropSharedCookies } from "../../../../web/src/svc/clearSite";
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PAGE, BRIDGE_READY, parseServicesHost, serviceOrigin } from "../../../../web/src/svc/protocol";

// covers: services.web-open

/**
 * What a contact's app kept on its own origin on the web (apps/web/src/svc/forget.ts, clearSite.ts) goes with the chat,
 * the profile's data or the profile: the app notes each origin it opens, and has the bridge on it clear it. The browser's
 * own part (the storage as Chromium keeps it) is e2e/web/services-web-forget.spec.ts.
 */
const host = parseServicesHost("https://*.svc.ghostly.example")!;
const label = (c: string) => c.repeat(32);

beforeAll(() => {
  // happy-dom would load the bridge page from the network: the frame and its messages are all these tests look at.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

/** Plays the bridge on every origin a frame loads, but `silent` ones: says it is ready, and clears when asked. */
function bridges(silent: string[] = []) {
  const asked: string[] = [];
  const observer = new MutationObserver(() => {
    for (const frame of document.querySelectorAll("iframe")) {
      if (frame.dataset.played) continue;
      frame.dataset.played = "1";
      const origin = new URL(frame.src).origin;
      expect(frame.src).toBe(`${origin}${BRIDGE_PAGE}`);
      // The bridge's window, as the app's page sees it: what it posts there, and what comes from it.
      const win = {
        postMessage: (data: { type?: string }, target: string) => {
          if (data?.type !== BRIDGE_CLEAR || target !== origin) return;
          asked.push(origin);
          if (!silent.includes(origin)) queueMicrotask(() => say(BRIDGE_CLEARED));
        },
      };
      Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
      const say = (type: string) => dispatchEvent(new MessageEvent("message", { data: { type }, origin, source: win as unknown as Window }));
      queueMicrotask(() => say(BRIDGE_READY));
    }
  });
  observer.observe(document.body, { childList: true });
  return { asked, stop: () => observer.disconnect() };
}

describe("the contacts' apps this device opened", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("are cleared by chat: only the deleted chat's, each by the bridge on its own origin, and then off the list", async () => {
    noteOpened({ profile: "", tag: "chat-a", label: label("y") });
    noteOpened({ profile: "", tag: "chat-a", label: label("b") });
    noteOpened({ profile: "", tag: "chat-b", label: label("n") });
    noteOpened({ profile: "", tag: "chat-a", label: label("y") });
    expect(openedServices()).toHaveLength(3);
    const bridge = bridges();
    try {
      await forgetServices(host, { tag: "chat-a" });
    } finally { bridge.stop(); }
    expect(bridge.asked).toEqual([serviceOrigin(host, label("y")), serviceOrigin(host, label("b"))]);
    expect(openedServices()).toEqual([{ profile: "", tag: "chat-b", label: label("n") }]);
    expect(document.querySelectorAll("iframe"), "no frame left behind").toHaveLength(0);
  });

  it("are cleared by profile, never another profile's; and the list goes once empty", async () => {
    noteOpened({ profile: "", tag: "chat-a", label: label("y") });
    noteOpened({ profile: "work000001", tag: "chat-w", label: label("w") });
    const bridge = bridges();
    try {
      await forgetServices(host, { profile: "work000001" });
      expect(bridge.asked).toEqual([serviceOrigin(host, label("w"))]);
      expect(openedServices()).toEqual([{ profile: "", tag: "chat-a", label: label("y") }]);
      await forgetServices(host, { profile: "" });
    } finally { bridge.stop(); }
    expect(localStorage.getItem(OPENED_KEY)).toBeNull();
  });

  it("keeps on the list one whose bridge never answered, for a later clear, and the others go on without it", async () => {
    vi.useFakeTimers();
    noteOpened({ profile: "", tag: "chat-a", label: label("y") });
    noteOpened({ profile: "", tag: "chat-a", label: label("b") });
    const bridge = bridges([serviceOrigin(host, label("y"))]);
    try {
      const done = forgetServices(host, { tag: "chat-a" });
      await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
      await done;
    } finally { bridge.stop(); }
    expect(bridge.asked).toEqual([serviceOrigin(host, label("y")), serviceOrigin(host, label("b"))]);
    expect(openedServices().map((o) => o.label)).toEqual([label("y")]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("hears no other frame or origin: a page of the contact's saying it cleared does not take it off the list", async () => {
    vi.useFakeTimers();
    noteOpened({ profile: "", tag: "chat-a", label: label("y") });
    const done = forgetServices(host, { tag: "chat-a" });
    dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_CLEARED }, origin: serviceOrigin(host, label("y")), source: window }));
    await vi.advanceTimersByTimeAsync(CLEAR_ORIGIN_MS);
    await done;
    expect(openedServices()).toHaveLength(1);
  });

  it("reads past a list that is not one", () => {
    localStorage.setItem(OPENED_KEY, "{");
    expect(openedServices()).toEqual([]);
    localStorage.setItem(OPENED_KEY, JSON.stringify([{ profile: "", tag: "t", label: "not-a-label" }, null]));
    expect(openedServices()).toEqual([]);
  });
});

/** The cookies `document.cookie` reads as `seen`, and every write to it, while it runs. */
function recordCookieWrites(seen: string) {
  const list: string[] = [];
  Object.defineProperty(document, "cookie", { configurable: true, get: () => seen, set: (value: string) => { list.push(value); } });
  return { list, stop: () => { delete (document as unknown as { cookie?: string }).cookie; } };
}

describe("the bridge's clear of its origin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("erases each kind the app may keep, and one the browser refuses keeps none of the others", async () => {
    localStorage.setItem("probe-k", "1");
    sessionStorage.setItem("probe-s", "1");
    document.cookie = "probe-c=1; Path=/";
    // The clock does not move while it clears: the cookie goes all the same.
    vi.useFakeTimers({ toFake: ["Date"] });
    const deleted: string[] = [];
    vi.stubGlobal("indexedDB", {
      databases: async () => [{ name: "probe-db" }, { name: "other" }],
      deleteDatabase: (name: string) => { deleted.push(name); const r = {} as IDBOpenDBRequest; queueMicrotask(() => r.onsuccess?.(new Event("success"))); return r; },
    });
    const cacheNames = new Set(["probe-cache"]);
    vi.stubGlobal("caches", { keys: async () => [...cacheNames], delete: async (key: string) => cacheNames.delete(key) });
    const unregistered = vi.fn(async () => true);
    const files = new Set(["a", "b"]);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => { throw new Error("SecurityError"); } },
      serviceWorker: { getRegistrations: async () => [{ unregister: unregistered }] },
    });

    await clearSite(host.suffix);

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain("probe-c");
    expect(deleted).toEqual(["probe-db", "other"]);
    expect([...cacheNames]).toEqual([]);
    expect(unregistered, "the worker goes even though the file system refused").toHaveBeenCalledOnce();
    expect(files.size).toBe(2);
  });

  it("expires each cookie it sees for the whole services host too, as a frame under another site may write it", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const writes = recordCookieWrites("probe-c=1; link=profile-a");
    try {
      await clearSite(host.suffix);
    } finally { writes.stop(); }
    for (const name of ["probe-c", "link"]) {
      const of = (domain: string) => writes.list.filter((w) => w.startsWith(`${name}=;`) && w.includes("Expires=Thu, 01 Jan 1970") && w.includes(domain));
      expect(of(`Domain=${host.suffix}`).find((w) => w.includes("Secure; SameSite=None") && !w.includes("Partitioned")), `${name} on the services host`).toBeTruthy();
      expect(of(`Domain=${host.suffix}`).find((w) => w.includes("Partitioned")), `${name} on the services host, partitioned`).toBeTruthy();
      expect(writes.list.filter((w) => w.startsWith(`${name}=;`) && !w.includes("Domain=")).find((w) => w.includes("Secure; SameSite=None")), `${name} of this origin`).toBeTruthy();
    }
  });

  it("drops only the services host's cookies before it frames an app, never this origin's own", () => {
    const writes = recordCookieWrites("mine=1; link=profile-a");
    try {
      dropSharedCookies(host.suffix);
    } finally { writes.stop(); }
    expect(writes.list.length).toBeGreaterThan(0);
    expect(writes.list.every((w) => w.includes(`; Domain=${host.suffix}`)), "a host-only cookie is another one: it stays").toBe(true);
    expect(new Set(writes.list.map((w) => w.split("=")[0]))).toEqual(new Set(["mine", "link"]));
  });

  it("empties the origin-private file system", async () => {
    const files = new Set(["a", "b"]);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => ({ async *keys() { yield* [...files]; }, removeEntry: async (name: string) => { files.delete(name); } }) },
      serviceWorker: { getRegistrations: async () => [] },
    });
    await clearSite(host.suffix);
    expect([...files]).toEqual([]);
  });
});
