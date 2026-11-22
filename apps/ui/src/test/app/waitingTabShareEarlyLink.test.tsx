import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { takeLinks } from "../../lib/otherTabLink";

// covers: app.single-peer-per-browser

/*
 * The web app's entry (apps/web/src/main.tsx) in a tab opened for a share while another tab of its profile is the app,
 * with a link reaching it before its waiting screen is drawn: the share is still forwarded after the wait, and the
 * link is handed on and taken out of the address like one that comes later.
 */

const CODE = vi.hoisted(() => "ghostly1p" + "q".repeat(211));

vi.mock("@ghostly/browser/inPageHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/inPageHost")>()),
  // Another tab holds the lock; like the real one, the waiting screen comes a moment after the lock was asked for, and
  // the link comes in that moment (the installed app sends it to the window used last).
  becomeThePeer: (_lock: string, onWaiting: () => void) => {
    window.location.hash = `#/${CODE}`;
    setTimeout(onWaiting, 150);
    return new Promise<void>(() => {});
  },
}));
vi.mock("@ghostly/browser/devices/gate", () => ({
  openDeviceGate: () => new Promise<never>(() => {}),
}));
vi.mock("../../lib/bootCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootCheck")>()),
  missingEssentials: async () => [],
}));
vi.mock("../../../../web/src/pwa/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/src/pwa/serviceWorker")>()),
  SHARE_FORWARD_AFTER_MS: 300,
  registerServiceWorker: () => {},
  followNewVersion: () => async () => {},
}));

describe("a tab opened for a share, given a link before its waiting screen", () => {
  it("forwards the share and hands the link on, out of its address", async () => {
    window.history.replaceState(null, "", "/#/shared");
    document.body.innerHTML = `<div id="root"></div>`;
    vi.stubGlobal("__APP_VERSION__", "0.0.0");
    vi.stubGlobal("__APP_BUILD__", "test");
    vi.stubGlobal("isSecureContext", true);
    const posted: unknown[] = [];
    const workers = Object.assign(new EventTarget(), { controller: { postMessage: (message: unknown) => posted.push(message) }, startMessages: () => {} });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: workers });
    const open = vi.fn();
    takeLinks("ghostly-peer", open);

    void import("../../../../web/src/main");
    await screen.findByText("Sending to Ghostly in your other tab…", undefined, { timeout: 20_000 });

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(`/${CODE}`), { timeout: 3000 });
    expect(window.location.hash).not.toContain("ghostly1");
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: "share-forward" })), { timeout: 3000 });
  }, 30_000);
});
