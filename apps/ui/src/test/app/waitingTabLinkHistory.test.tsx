import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { takeLinks } from "../../lib/otherTabLink";

// covers: app.single-peer-per-browser

/*
 * The web app's entry (apps/web/src/main.tsx) in a tab that waits behind another tab of its profile, with two links
 * reaching it before the first is answered: neither stays in the tab's history (Back hands nothing on again), and one
 * still unanswered when this tab takes the profile over is this tab's to open.
 */

let takeOver = () => {};
vi.mock("@ghostly/browser/inPageHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/inPageHost")>()),
  // Another tab holds the lock until the test hands it over.
  becomeThePeer: (_lock: string, onWaiting: () => void) => { onWaiting(); return new Promise<void>((resolve) => { takeOver = resolve; }); },
}));
vi.mock("@ghostly/browser/devices/gate", () => ({
  // Nothing of the profile starts here: the address as this tab takes over is what is looked at.
  openDeviceGate: () => new Promise<never>(() => {}),
}));
vi.mock("../../lib/bootCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootCheck")>()),
  missingEssentials: async () => [],
}));
vi.mock("../../../../web/src/pwa/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/src/pwa/serviceWorker")>()),
  SHARE_FORWARD_AFTER_MS: 300,
  followNewVersion: () => async () => {},
}));

const CODE = "ghostly1p" + "q".repeat(211);
const GROUP = "/join/group2/abc";
const OTHER = "/join/group2/def";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a tab that waits behind another tab, given two links at once", () => {
  it("keeps neither in its history, and opens one still unanswered once it takes over", async () => {
    window.history.replaceState(null, "", "/#/");
    document.body.innerHTML = `<div id="root"></div>`;
    vi.stubGlobal("__APP_VERSION__", "0.0.0");
    vi.stubGlobal("__APP_BUILD__", "test");
    const open = vi.fn();
    const holder = takeLinks("ghostly-peer", open);
    // The entry waits here for a lock the test gives it only at the end.
    void import("../../../../web/src/main");
    await screen.findByText("Ghostly is already open in another tab.", undefined, { timeout: 20_000 });

    // The second comes before the first was asked for.
    window.location.hash = `#/${CODE}`;
    await pause(50);
    window.location.hash = `#${GROUP}`;
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenNthCalledWith(1, `/${CODE}`);
    expect(open).toHaveBeenNthCalledWith(2, GROUP);
    expect(window.location.hash).toBe("#/");

    // Back finds neither link: nothing is handed on again.
    window.history.back();
    await pause(50);
    expect(window.location.hash).not.toContain("ghostly1");
    expect(window.location.hash).not.toContain("/join/");
    await pause(700);
    expect(open).toHaveBeenCalledTimes(2);

    // No tab takes the next one: it is out of the address while it waits, and back in it once this tab takes over.
    holder();
    window.location.hash = `#${OTHER}`;
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    takeOver();
    await vi.waitFor(() => expect(window.location.hash).toBe(`#${OTHER}`));
  }, 30_000);
});
