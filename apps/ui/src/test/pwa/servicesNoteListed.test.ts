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
  await vi.waitFor(() => expect(openedServices()).toEqual(labels.map((label) => ({ profile: "", tag, label }))));

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
