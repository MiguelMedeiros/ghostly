import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PORT } from "../../../../web/src/svc/protocol";

// covers: services.web-open

/**
 * The bridge (apps/web/src/svc/bridge.ts) on a contact's app origin: the frame it puts the contact's app in, once the
 * app's page handed it its port. The view's frame around it is servicesOpener.test.ts.
 */
const APP_ORIGIN = "https://app.ghostly.example";
const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.replaceChildren(); });

async function bridgeFrame(): Promise<HTMLIFrameElement> {
  const dom = (window as unknown as { happyDOM?: { setURL(url: string): void; settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM!;
  Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  dom.setURL(`https://${LABEL}.svc.ghostly.example/_ghostly-svc/bridge.html`);
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
  vi.stubGlobal("__SERVICES_APP_ORIGIN__", APP_ORIGIN);
  vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
  const workers = Object.assign(new EventTarget(), { startMessages: () => {}, register: async () => ({}), ready: Promise.resolve({}) });
  Object.defineProperty(navigator, "serviceWorker", { value: workers, configurable: true });
  // The server's clear of the services host's cookies, before the app is framed.
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  await import("../../../../web/src/svc/bridge");
  expect(parent.postMessage).toHaveBeenCalled();
  const { port1 } = new MessageChannel();
  window.dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_PORT }, origin: APP_ORIGIN, source: parent as unknown as Window, ports: [port1] }));
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  return document.querySelector("iframe")!;
}

describe("the bridge's frame of the contact's app", () => {
  it("writes nothing to the clipboard by itself: no `clipboard-write`", async () => {
    const frame = await bridgeFrame();
    expect((frame.getAttribute("allow") ?? "").split(";").map((feature) => feature.trim())).not.toContain("clipboard-write");
  });
});
