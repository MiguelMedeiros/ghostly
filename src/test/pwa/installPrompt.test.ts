import { afterEach, describe, expect, it, vi } from "vitest";
import { installState, isAppleMobile, promptInstall, resetInstallPrompt, watchInstallPrompt } from "../../lib/installPrompt";

// covers: app.pwa.install

afterEach(() => resetInstallPrompt());

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
});
