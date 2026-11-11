import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIPBOARD_GUARD_HASH, CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_HASH, VIEWER_GUARD_SCRIPT } from "@ghostly/core";
import { BRIDGE_PORT, BRIDGE_REFUSED } from "../../../../web/src/svc/protocol";
import { runBridgeGuard } from "../pwaBridgeGuard";

// covers: services.web-open

/**
 * The bridge (apps/web/src/svc/bridge.ts) on a contact's app origin: the frame it puts the contact's app in, once the
 * app's page handed it its port. The worker under it is e2e/web/services-web-open.spec.ts.
 */
const APP_ORIGIN = "https://app.ghostly.example";
const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.replaceChildren(); });

async function bridgeFrame(relayOnly?: boolean): Promise<HTMLIFrameElement> {
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
  runBridgeGuard();
  await import("../../../../web/src/svc/bridge");
  expect(parent.postMessage).toHaveBeenCalled();
  const { port1 } = new MessageChannel();
  window.dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_PORT, ...(relayOnly === undefined ? {} : { relayOnly }) }, origin: APP_ORIGIN, source: parent as unknown as Window, ports: [port1] }));
  await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  return document.querySelector("iframe")!;
}

describe("the bridge's frame of the contact's app", () => {
  it("cannot take the screen from the view's bar: no full screen", async () => {
    const frame = await bridgeFrame();
    expect(frame.getAttribute("allow")).toBe("");
  });

  it("runs the WebRTC guard first while Hide my IP from contacts is on: the app's frame, on this origin, reaches this window", async () => {
    // covers: settings.network.relay-only
    const guards = () => [...document.head.querySelectorAll("script")].filter((script) => script.textContent === VIEWER_GUARD_SCRIPT);
    for (const relayOnly of [false, undefined, true]) {
      document.head.replaceChildren();
      vi.resetModules();
      await bridgeFrame(relayOnly);
      expect(guards(), String(relayOnly)).toHaveLength(relayOnly ? 1 : 0);
    }
    // Inline: the bridge's policy allows it by its hash, in the page and from the server.
    const web = (file: string) => readFileSync(join(import.meta.dirname, "../../../../web", file), "utf8");
    expect(web("svcBuild.ts")).toContain("script-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH};");
    expect(web("nginx-services.conf")).toContain(`script-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH};`);
  });

  it("runs the clipboard guard always, before the app's frame is made: the app's page reaches this window's execCommand", async () => {
    for (const relayOnly of [false, true]) {
      document.head.replaceChildren();
      vi.resetModules();
      await bridgeFrame(relayOnly);
      const scripts = [...document.head.querySelectorAll("script")].map((script) => script.textContent);
      expect(scripts[0], String(relayOnly)).toBe(CLIPBOARD_GUARD_SCRIPT);
    }
  });

  it("tells the app's page when the browser refuses it the services worker, so it says why in the profile's words", async () => {
    // Firefox blocking third-party cookies: the services host is a site of its own, its worker a third party's.
    const dom = (window as unknown as { happyDOM?: { setURL(url: string): void; settings: { disableIframePageLoading: boolean } } }).happyDOM!;
    dom.settings.disableIframePageLoading = true;
    dom.setURL(`https://${LABEL}.svc.ghostly.example/_ghostly-svc/bridge.html`);
    const parent = { postMessage: vi.fn() };
    vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
    vi.stubGlobal("__SERVICES_APP_ORIGIN__", APP_ORIGIN);
    vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
    const refusal = Object.assign(new Error("The operation is insecure."), { name: "SecurityError" });
    const workers = Object.assign(new EventTarget(), { startMessages: () => {}, register: async () => { throw refusal; }, ready: Promise.resolve({}) });
    Object.defineProperty(navigator, "serviceWorker", { value: workers, configurable: true });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    await import("../../../../web/src/svc/bridge");
    window.dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_PORT }, origin: APP_ORIGIN, source: parent as unknown as Window, ports: [new MessageChannel().port1] }));
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith({ type: BRIDGE_REFUSED, reason: "blocked" }, APP_ORIGIN));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not show a page it cannot read, nor take a frame's word for which page is in it", async () => {
    // Which pages it shows, the guard's and those without scripts, is e2e/web/services-web-clipboard.spec.ts's: the
    // getters it reads are a browser's `Document.prototype`'s.
    vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
    vi.stubGlobal("__SERVICES_APP_ORIGIN__", APP_ORIGIN);
    const { guardedDocument, guardedPage } = await import("../../../../web/src/svc/bridge");
    // Cross-origin or opaque (a `sandbox` policy of the page's own): nothing to read, not shown.
    expect(guardedDocument(null)).toBe(false);
    // A `contentDocument` the app's page put on the frame is not what is read: the getter was taken before.
    const frame = document.createElement("iframe");
    Object.defineProperty(frame, "contentDocument", { get: () => ({ URL: "about:blank" }) });
    expect(guardedPage(frame)).toBe(false);
  });

  it("hands the app's page each link the app opens in a new window, which the view's sandbox would drop with no word", async () => {
    vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
    vi.stubGlobal("__SERVICES_APP_ORIGIN__", APP_ORIGIN);
    const { forwardLinks } = await import("../../../../web/src/svc/bridge");
    const realOpen = window.open;
    const asked: string[] = [];
    try {
      forwardLinks(window, (url) => asked.push(url));
      const link = (attributes: Record<string, string>) => {
        const a = document.createElement("a");
        for (const [name, value] of Object.entries(attributes)) a.setAttribute(name, value);
        a.textContent = "link";
        document.body.append(a);
        return a;
      };
      link({ href: "https://docs.example/a", target: "_blank" }).click();
      link({ href: "https://docs.example/b", target: "_BLANK" }).click();
      // Its own page's links, and one the app took itself, stay the app's.
      link({ href: "#next" }).click();
      const taken = link({ href: "https://docs.example/taken", target: "_blank" });
      taken.addEventListener("click", (event) => event.preventDefault());
      taken.click();
      expect(window.open("https://docs.example/c")).toBeNull();
      window.open("/relative", "_blank");
      expect(asked).toEqual(["https://docs.example/a", "https://docs.example/b", "https://docs.example/c", new URL("/relative", document.baseURI).href]);
    } finally {
      window.open = realOpen;
    }
  });
});
