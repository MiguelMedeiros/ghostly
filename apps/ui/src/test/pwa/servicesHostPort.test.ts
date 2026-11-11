import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLEAR_ORIGIN_MS, forgetServices, noteOpened, openedServices } from "../../../../web/src/svc/forget";
import { openServiceView, serviceLabel } from "../../../../web/src/svc/opener";
import { BRIDGE_CLEAR, BRIDGE_CLEARED, BRIDGE_PORT, BRIDGE_READY, closeServiceView, parseAppOrigin, parseServicesHost, serviceOrigin } from "../../../../web/src/svc/protocol";

// covers: services.web-open

/**
 * A services host (or the app's origin) given to the build with its scheme's own port (`https://*.svc.example:443`):
 * the browser writes the origin without it, so every origin the app names from the setting must too, or no message
 * from the bridge ever matches it (apps/web/src/svc/protocol.ts).
 */
const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";
const PEER = "o".repeat(52);
const host = parseServicesHost("https://*.svc.ghostly.example:443")!;

beforeAll(() => {
  // happy-dom would load the bridge page from the network: the frame and its messages are all these tests look at.
  const dom = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
  if (dom) Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
});

describe("a services host given with a port", () => {
  it("names origins as the browser writes them: the scheme's own port dropped, any other kept", () => {
    expect(parseServicesHost("https://*.svc.example:443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("http://*.localhost:80")).toEqual({ protocol: "http:", suffix: "localhost", port: "" });
    expect(parseServicesHost("https://*.svc.example:8443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "8443" });
    expect(parseServicesHost("https://*.svc.example:80")).toEqual({ protocol: "https:", suffix: "svc.example", port: "80" });
    expect(parseServicesHost("http://*.localhost:443")).toEqual({ protocol: "http:", suffix: "localhost", port: "443" });
    expect(parseServicesHost("https://*.svc.example")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("https://*.svc.example:0443")).toEqual({ protocol: "https:", suffix: "svc.example", port: "" });
    expect(parseServicesHost("https://*.svc.example:99999"), "no port at all").toBeNull();
    expect(serviceOrigin(host, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example`);
    expect(serviceOrigin(parseServicesHost("https://*.svc.ghostly.example:8443")!, LABEL)).toBe(`https://${LABEL}.svc.ghostly.example:8443`);
    expect(serviceOrigin(parseServicesHost("http://*.localhost:80")!, LABEL)).toBe(`http://${LABEL}.localhost`);
  });

  it("takes the app's own origin in the browser's form too, the one the bridge compares each message with", () => {
    expect(parseAppOrigin("https://app.example:443")).toBe("https://app.example");
    expect(parseAppOrigin("http://localhost:80")).toBe("http://localhost");
    expect(parseAppOrigin("https://app.example:8443")).toBe("https://app.example:8443");
    expect(parseAppOrigin("http://localhost:4173")).toBe("http://localhost:4173");
    expect(parseAppOrigin("https://app.example")).toBe("https://app.example");
    for (const bad of [undefined, "", "https://app.example/", "https://app.example/path", "javascript:alert(1)", "https://app.example:99999"]) {
      expect(parseAppOrigin(bad), String(bad)).toBeNull();
    }
    // The build hands the bridge that form, not the setting as written.
    const svcBuild = readFileSync(join(import.meta.dirname, "../../../../web/svcBuild.ts"), "utf8");
    expect(svcBuild).toContain("parseAppOrigin(appOrigin)");
    expect(svcBuild).toContain("__SERVICES_APP_ORIGIN__: JSON.stringify(origin)");
  });

  it("hands the bridge its port when it says it loaded, from the origin the browser gives it", async () => {
    const words = { unreachable: "Not reachable", failed: "Failed", close: "Close", callOn: "End the call to open it.", tooSlow: "Too slow", offline: "Your contact is offline", retry: "Try again", blocked: "", unguarded: "", label: "Demo, shared by Demo bot", owner: "Demo bot's app, running on their machine. Not Ghostly.", hostError: () => null };
    try {
      await openServiceView({ host, tag: "ybndrfg8ejkmcpqx", peer: PEER, service: "demo", title: "Demo", send: async () => { throw new Error("not asked"); }, words });
      const origin = `https://${await serviceLabel("ybndrfg8ejkmcpqx", PEER, "demo")}.svc.ghostly.example`;
      const frame = document.querySelector<HTMLIFrameElement>("[data-testid=service-view-frame]")!;
      const inFrame = { postMessage: vi.fn() };
      Object.defineProperty(frame, "contentWindow", { value: inFrame, configurable: true });
      dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_READY }, origin, source: inFrame as unknown as Window }));
      expect(inFrame.postMessage).toHaveBeenCalledTimes(1);
      expect(inFrame.postMessage.mock.calls[0]![0]).toMatchObject({ type: BRIDGE_PORT });
      expect(inFrame.postMessage.mock.calls[0]![1]).toBe(origin);
    } finally {
      closeServiceView();
    }
  });

  describe("clearing an opened app's origin", () => {
    afterEach(() => localStorage.clear());

    it("is done by the bridge on it, from the origin the browser gives it", async () => {
      noteOpened({ profile: "", tag: "chat-a", label: LABEL });
      const origin = `https://${LABEL}.svc.ghostly.example`;
      const asked: string[] = [];
      // Plays the bridge on the frame's origin as the browser names it: ready, and cleared when asked.
      const observer = new MutationObserver(() => {
        for (const frame of document.querySelectorAll("iframe")) {
          if (frame.dataset.played) continue;
          frame.dataset.played = "1";
          const win = {
            postMessage: (data: { type?: string }, target: string) => {
              if (data?.type !== BRIDGE_CLEAR) return;
              asked.push(target);
              queueMicrotask(() => say(BRIDGE_CLEARED));
            },
          };
          Object.defineProperty(frame, "contentWindow", { value: win, configurable: true });
          const say = (type: string) => dispatchEvent(new MessageEvent("message", { data: { type }, origin, source: win as unknown as Window }));
          queueMicrotask(() => say(BRIDGE_READY));
        }
      });
      observer.observe(document.body, { childList: true });
      try {
        await forgetServices(host, { tag: "chat-a" });
      } finally { observer.disconnect(); }
      expect(asked).toEqual([origin]);
      expect(openedServices(), "cleared, so off the list").toEqual([]);
    }, CLEAR_ORIGIN_MS + 5_000);
  });
});
