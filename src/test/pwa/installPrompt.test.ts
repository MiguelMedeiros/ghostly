import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeInstallSteps, dismissInstallHint, installHintShown, installState, installVisits, isAppleMobile, isMacSafari, promptInstall,
  resetInstallPrompt, startInstall, installStepsOpen, watchInstallPrompt,
} from "../../lib/installPrompt";

// covers: app.pwa.install, app.pwa.install-entry

afterEach(() => {
  vi.restoreAllMocks();
  resetInstallPrompt();
  localStorage.clear();
});

const SAFARI_MAC = (version: number) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version}.0 Safari/605.1.15`;
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE_MAC = `${CHROME_MAC} Edg/131.0.0.0`;
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";

/** The page as this browser, for `installState()` (which reads navigator itself). */
function asBrowser(userAgent: string, touchPoints = 0) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(touchPoints);
}

function offer(outcome: "accepted" | "dismissed") {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome }),
  });
  window.dispatchEvent(event);
  return event;
}

describe("installing the web app", () => {
  it("offers nothing where the page does not watch (the extension, Desktop)", () => {
    offer("accepted");
    expect(installState()).toBe("none");
  });

  it("takes the browser's offer (no banner of its own) and installs on request", async () => {
    watchInstallPrompt();
    const event = offer("accepted");
    expect(event.defaultPrevented).toBe(true);
    expect(installState()).toBe("prompt");
    await expect(promptInstall()).resolves.toBe(true);
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // An offer is used once.
    expect(installState()).not.toBe("prompt");
    await expect(promptInstall()).resolves.toBe(false);
    window.dispatchEvent(new Event("appinstalled"));
    expect(installState()).toBe("installed");
  });

  it("a person who says no gets no second prompt from the same offer", async () => {
    watchInstallPrompt();
    offer("dismissed");
    await expect(promptInstall()).resolves.toBe(false);
  });

  it("recognises iPhones and iPads, which install from Safari's Share menu", () => {
    expect(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isAppleMobile("Mozilla/5.0 (Linux; Android 15)", 5)).toBe(false);
  });

  it("recognises Safari on a Mac from 17, which adds the app to the Dock from its File menu", () => {
    expect(isMacSafari(SAFARI_MAC(17), 0)).toBe(true);
    expect(isMacSafari(SAFARI_MAC(18), 0)).toBe(true);
    expect(isMacSafari(SAFARI_MAC(16), 0)).toBe(false);
    // Chromium browsers on a Mac say Safari too; they have the prompt instead. Firefox has no install at all.
    expect(isMacSafari(CHROME_MAC, 0)).toBe(false);
    expect(isMacSafari(EDGE_MAC, 0)).toBe(false);
    expect(isMacSafari(FIREFOX_MAC, 0)).toBe(false);
    // An iPad asking for desktop sites says Macintosh, with a touch screen: Share menu, not File menu.
    expect(isMacSafari(SAFARI_MAC(18), 5)).toBe(false);
    expect(isMacSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", 5)).toBe(false);
  });

  it("offers the Dock on Safari for Mac, the Share menu on an iPad in desktop mode, and nothing on Firefox", () => {
    watchInstallPrompt();
    asBrowser(SAFARI_MAC(17));
    expect(installState()).toBe("dock");
    asBrowser(SAFARI_MAC(17), 5);
    expect(installState()).toBe("ios");
    asBrowser(FIREFOX_MAC);
    expect(installState()).toBe("none");
  });

  it("the browser's offer comes before any steps: Chromium on a Mac gets its prompt", () => {
    watchInstallPrompt();
    asBrowser(CHROME_MAC);
    expect(installState()).toBe("none");
    offer("accepted");
    expect(installState()).toBe("prompt");
  });

  it("Install on Safari opens the steps, which close again", () => {
    watchInstallPrompt();
    asBrowser(SAFARI_MAC(18));
    expect(installStepsOpen()).toBe(false);
    startInstall();
    expect(installStepsOpen()).toBe(true);
    closeInstallSteps();
    expect(installStepsOpen()).toBe(false);
  });

  it("Install where the browser offers it asks the browser, and opens no steps", async () => {
    watchInstallPrompt();
    const event = offer("accepted");
    startInstall();
    await vi.waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    expect(installStepsOpen()).toBe(false);
  });
});

describe("the hint above the chat list", () => {
  it("waits until the app has been used a little: a chat of its own, or a second visit", () => {
    watchInstallPrompt();
    offer("accepted");
    expect(installVisits()).toBe(1);
    expect(installHintShown(installState(), false)).toBe(false);
    expect(installHintShown(installState(), true)).toBe(true);

    // The next time the web app opens (a new page: the watch starts over).
    resetInstallPrompt();
    watchInstallPrompt();
    offer("accepted");
    expect(installVisits()).toBe(2);
    expect(installHintShown(installState(), false)).toBe(true);
  });

  it("Not now puts it away for good, and Install stays where it was", () => {
    watchInstallPrompt();
    offer("accepted");
    dismissInstallHint();
    expect(installHintShown(installState(), true)).toBe(false);
    resetInstallPrompt();
    watchInstallPrompt();
    offer("accepted");
    expect(installHintShown(installState(), true)).toBe(false);
    expect(installState()).toBe("prompt");
  });

  it("once Install was used it has done its job (Safari never says the app was added)", () => {
    watchInstallPrompt();
    asBrowser(SAFARI_MAC(18));
    expect(installHintShown(installState(), true)).toBe(true);
    startInstall();
    expect(installHintShown(installState(), true)).toBe(false);
  });

  it("goes once the app is installed, and never shows in the installed app", () => {
    watchInstallPrompt();
    offer("accepted");
    expect(installHintShown(installState(), true)).toBe(true);
    window.dispatchEvent(new Event("appinstalled"));
    expect(installHintShown(installState(), true)).toBe(false);

    resetInstallPrompt();
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    watchInstallPrompt();
    expect(installState()).toBe("installed");
    expect(installHintShown(installState(), true)).toBe(false);
  });

  it("never shows in the extension or Desktop, which do not watch", () => {
    asBrowser(SAFARI_MAC(18));
    offer("accepted");
    expect(installState()).toBe("none");
    expect(installHintShown(installState(), true)).toBe(false);
  });

  it("works where storage refuses (a private window): shown once there are chats, Not now still puts it away", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(() => watchInstallPrompt()).not.toThrow();
    offer("accepted");
    expect(installVisits()).toBe(0);
    expect(installHintShown(installState(), true)).toBe(true);
    expect(() => dismissInstallHint()).not.toThrow();
    expect(installHintShown(installState(), true)).toBe(false);
  });
});
