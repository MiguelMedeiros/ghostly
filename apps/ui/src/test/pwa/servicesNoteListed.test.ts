import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MAX_SERVICES, viewerTag } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { serviceLabel } from "../../../../web/src/svc/opener";
import { BRIDGE_PAGE, parseServicesHost, serviceOrigin } from "../../../../web/src/svc/protocol";
import { linkView } from "../fakeEngine";

// covers: services.web-open

/**
 * A contact's app opened on the web before the opened-apps list was kept is on no list: the web host notes every app
 * each chat lists as the list comes (apps/web/src/host.ts), so what it kept on its origin goes with Delete chat, Clear
 * all data and Delete profile too.
 */
const ME = "y".repeat(52);
const ANA = "o".repeat(52);
const BEN = "b".repeat(52);
const host = parseServicesHost("https://*.svc.ghostly.example")!;

beforeAll(() => {
  // happy-dom would load the bridge page from the network: the frames are all this test looks at.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

/** The web host with a services host, in a browser with service workers, and the engine it hears. */
async function webHost() {
  vi.stubGlobal("__APP_VERSION__", "0.0.0");
  vi.stubGlobal("__APP_BUILD__", "test");
  vi.stubEnv("VITE_SERVICES_HOST", "https://*.svc.ghostly.example");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
  vi.resetModules();
  const { engine } = await import("@ghostly/browser/platform/engine");
  const listeners: (() => void)[] = [];
  vi.spyOn(engine, "subscribe").mockImplementation((listener) => { listeners.push(listener); return () => {}; });
  const { webHost } = await import("../../../../web/src/host");
  const emit = (links: LinkView[]) => {
    engine.state = { links, edges: [] } as unknown as EngineState;
    for (const listener of [...listeners]) listener();
  };
  return { webHost, emit };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (window as { isSecureContext?: boolean }).isSecureContext;
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  localStorage.clear();
  vi.useRealTimers();
});

it("notes every app a chat lists, never one it cannot open, and clears each with the chat", async () => {
  const { webHost: web, emit } = await webHost();
  const ana = linkView({ id: "ana", myPubKeyZ32: ME, peerPubKeyZ32: ANA, peerServices: [{ id: "album", type: "http", name: "Album" }, { id: "wiki", type: "http" }, { id: "talk", type: "voice" }] });
  const ben = linkView({ id: "ben", myPubKeyZ32: BEN, peerPubKeyZ32: BEN, peerServices: null });
  emit([ana, ben]);
  emit([ana, ben]);

  const tag = viewerTag(ME);
  const labels = [await serviceLabel(tag, ANA, "album"), await serviceLabel(tag, ANA, "wiki")];
  const { openedServices } = await import("../../../../web/src/svc/forget");
  // Each state notes its own way through the list, a label (a digest) at a time, so the second can note wiki before
  // the first notes album: the list is a set of origins to clear (filtered, never shown, cleared all at once), so only
  // which entries it holds, each once, is checked, not their order.
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  await vi.waitFor(() => expect(openedServices().sort(byLabel)).toEqual(labels.map((label) => ({ profile: "", tag, label })).sort(byLabel)));

  // Delete chat: the bridge on each origin is asked to clear it.
  vi.useFakeTimers();
  const forgetting = web.forgetServices!({ tag });
  await vi.advanceTimersByTimeAsync(0);
  expect([...document.querySelectorAll("iframe")].map((frame) => frame.src).sort())
    .toEqual(labels.map((label) => `${serviceOrigin(host, label)}${BRIDGE_PAGE}`).sort());
  await vi.runAllTimersAsync();
  await forgetting;
});

it("notes no more of a chat's listed apps than one list holds, however many new ones its contact lists", async () => {
  const { webHost: web, emit } = await webHost();
  // A contact lists at most MAX_SERVICES apps at a time, but a new list of new ones at any time.
  for (let round = 0; round < 20; round++) {
    const peerServices = Array.from({ length: MAX_SERVICES }, (_, i) => ({ id: `app-${round}-${i}`, type: "http" as const }));
    emit([linkView({ id: "ana", myPubKeyZ32: ME, peerPubKeyZ32: ANA, peerServices })]);
  }
  const tag = viewerTag(ME);
  const { openedServices, noteOpened } = await import("../../../../web/src/svc/forget");
  await vi.waitFor(() => expect(openedServices()).toHaveLength(MAX_SERVICES));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(openedServices()).toHaveLength(MAX_SERVICES);

  // One the person opens is still noted: what it keeps goes with the chat.
  const opened = { profile: "", tag, label: await serviceLabel(tag, ANA, "opened") };
  noteOpened(opened);
  expect(openedServices()).toContainEqual(opened);

  // Delete chat loads no more bridges at once than that.
  vi.useFakeTimers();
  const forgetting = web.forgetServices!({ tag });
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelectorAll("iframe")).toHaveLength(MAX_SERVICES + 1);
  await vi.runAllTimersAsync();
  await forgetting;
});

/** `chats` chats, each listing `apps` apps of its own contact, as a page load sees them. */
function chats(count: number, apps: number): LinkView[] {
  return Array.from({ length: count }, (_, c) => {
    const key = `${c}`.padStart(52, "k");
    return linkView({ id: `chat-${key}`, myPubKeyZ32: key, peerPubKeyZ32: key.replace(/k/g, "p"), peerServices: Array.from({ length: apps }, (_, i) => ({ id: `app-${i}`, type: "http" as const })) });
  });
}

it("reads the opened-apps list once for a page load's listed apps, however many there are", async () => {
  vi.resetModules();
  const { noteListed, openedServices, OPENED_KEY } = await import("../../../../web/src/svc/forget");
  // 160 apps (10 chats at MAX_SERVICES), all new to this page: the list grows to 160 entries.
  const links = chats(10, MAX_SERVICES);
  const getItem = vi.spyOn(localStorage, "getItem");
  const setItem = vi.spyOn(localStorage, "setItem");
  const reads = () => getItem.mock.calls.filter(([key]) => key === OPENED_KEY).length;
  const writes = () => setItem.mock.calls.filter(([key]) => key === OPENED_KEY).length;
  try {
    await noteListed("", links);
    expect(reads()).toBe(1);
    expect(writes()).toBe(1);
    expect(openedServices()).toHaveLength(10 * MAX_SERVICES);

    // The next state lists the same apps: nothing new, so the list is neither read nor written.
    getItem.mockClear();
    setItem.mockClear();
    await noteListed("", links);
    expect(reads()).toBe(0);
    expect(writes()).toBe(0);

    // New apps that all sit past their chats' cap: one read, and nothing written.
    await noteListed("", links.map((link) => ({ ...link, peerServices: [{ id: "one-more", type: "http" as const }] })));
    expect(reads()).toBe(1);
    expect(writes()).toBe(0);
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});

it("notes the same apps, in the same order and under the same per-chat cap, as noting them one at a time", async () => {
  vi.resetModules();
  const { noteListed, noteOpened, openedServices, OPENED_KEY } = await import("../../../../web/src/svc/forget");
  const [full, over, near, other] = chats(4, 0);
  const apps = (n: number, prefix = "app") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, type: "http" as const }));
  // A chat listing more than the cap, one already near it with some of its apps noted, one already full, a voice app,
  // an app listed twice in one chat, and another profile's entries for the same chat (not counted against this one).
  const links: LinkView[] = [
    { ...over, peerServices: [...apps(MAX_SERVICES + 5), { id: "talk", type: "voice" }] },
    { ...near, peerServices: [...apps(6), ...apps(6), ...apps(8, "new")] },
    { ...full, peerServices: apps(3, "late") },
    { ...other, peerServices: null },
  ];
  const seed = async () => {
    const entries = [
      ...await Promise.all(apps(MAX_SERVICES, "old").map(async ({ id }) => ({ profile: "p", tag: viewerTag(full.myPubKeyZ32), label: await serviceLabel(viewerTag(full.myPubKeyZ32), full.peerPubKeyZ32, id) }))),
      ...await Promise.all(apps(MAX_SERVICES - 4).map(async ({ id }) => ({ profile: "p", tag: viewerTag(near.myPubKeyZ32), label: await serviceLabel(viewerTag(near.myPubKeyZ32), near.peerPubKeyZ32, id) }))),
      ...await Promise.all(apps(MAX_SERVICES, "q").map(async ({ id }) => ({ profile: "q", tag: viewerTag(over.myPubKeyZ32), label: await serviceLabel(viewerTag(over.myPubKeyZ32), over.peerPubKeyZ32, id) }))),
    ];
    localStorage.setItem(OPENED_KEY, JSON.stringify(entries));
  };

  // The way the web noted them before: counted and noted one app at a time.
  await seed();
  for (const link of links) {
    for (const service of link.peerServices ?? []) {
      if (service.type !== "http") continue;
      const tag = viewerTag(link.myPubKeyZ32);
      const label = await serviceLabel(tag, link.peerPubKeyZ32, service.id);
      if (openedServices().filter((o) => o.profile === "p" && o.tag === tag).length >= MAX_SERVICES) continue;
      noteOpened({ profile: "p", tag, label });
    }
  }
  const oneAtATime = localStorage.getItem(OPENED_KEY);
  localStorage.clear();

  await seed();
  await noteListed("p", links);
  expect(localStorage.getItem(OPENED_KEY)).toBe(oneAtATime);
  // Each chat of profile p holds at most the cap, and the chat over it holds its first MAX_SERVICES apps.
  const tags = [over, near, full].map((link) => viewerTag(link.myPubKeyZ32));
  for (const tag of tags) expect(openedServices().filter((o) => o.profile === "p" && o.tag === tag)).toHaveLength(MAX_SERVICES);
  const overLabels = await Promise.all(apps(MAX_SERVICES).map(({ id }) => serviceLabel(tags[0], over.peerPubKeyZ32, id)));
  expect(openedServices().filter((o) => o.profile === "p" && o.tag === tags[0]).map((o) => o.label)).toEqual(overLabels);
});
