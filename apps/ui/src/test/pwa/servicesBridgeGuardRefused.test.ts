import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PORT, BRIDGE_READY } from "../../../../web/src/svc/protocol";
import { runBridgeGuard } from "../pwaBridgeGuard";

// covers: services.web-open

/**
 * The bridge (apps/web/src/svc/bridge.ts) when its server's policy refuses one of its inline guards (a hash that is not
 * this build's): it shows no app then. happy-dom runs no script, as such a policy would have the browser do.
 */
const APP_ORIGIN = "https://app.ghostly.example";
const LABEL = "ybndrfg8ejkmcpqxot1uwisza345h769";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.replaceChildren(); document.head.replaceChildren(); });

async function openBridge(): Promise<{ postMessage: ReturnType<typeof vi.fn> }> {
  const dom = (window as unknown as { happyDOM?: { setURL(url: string): void; settings: { disableIframePageLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM!;
  Object.assign(dom.settings, { disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true });
  dom.setURL(`https://${LABEL}.svc.ghostly.example/_ghostly-svc/bridge.html`);
  const parent = { postMessage: vi.fn() };
  vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
  vi.stubGlobal("__SERVICES_APP_ORIGIN__", APP_ORIGIN);
  vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
  const workers = Object.assign(new EventTarget(), { startMessages: () => {}, register: async () => ({}), ready: Promise.resolve({}) });
  Object.defineProperty(navigator, "serviceWorker", { value: workers, configurable: true });
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../../../web/src/svc/bridge");
  return parent;
}

function handPort(parent: { postMessage: unknown }, relayOnly: boolean): void {
  const { port1 } = new MessageChannel();
  window.dispatchEvent(new MessageEvent("message", { data: { type: BRIDGE_PORT, relayOnly }, origin: APP_ORIGIN, source: parent as unknown as Window, ports: [port1] }));
}

describe("the bridge whose policy refused its guard", () => {
  // First in the file: what the guard leaves stays fixed once it ran (runBridgeGuard).
  it("asks for no port and frames no app when the clipboard guard did not run", async () => {
    const parent = await openBridge();
    expect(parent.postMessage).not.toHaveBeenCalledWith({ type: BRIDGE_READY }, APP_ORIGIN);
    handPort(parent, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("cannot be opened here");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("the clipboard guard"));
  });

  it("frames no app with Hide my IP from contacts on when the WebRTC guard did not run", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    runBridgeGuard();
    const parent = await openBridge();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: BRIDGE_READY }, APP_ORIGIN);
    handPort(parent, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("cannot be opened here");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("the WebRTC guard"));
  });

  it("frames the app when both ran (Hide my IP off: no WebRTC guard is asked for)", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    runBridgeGuard();
    const parent = await openBridge();
    handPort(parent, false);
    await vi.waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  });
});
