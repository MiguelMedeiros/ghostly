import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { linkInAddress } from "../../lib/otherTabLink";

// covers: app.single-peer-per-browser

/*
 * The web app's entry (apps/web/src/main.tsx) in a tab that waits behind another tab of its profile, with two links
 * reaching it that no tab answers (the app's tab is going away): once this tab takes the profile over, it opens both,
 * one after the other, and loses neither.
 */

let takeOver = () => {};
vi.mock("@ghostly/browser/inPageHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/inPageHost")>()),
  // Another tab holds the lock until the test hands it over.
  becomeThePeer: (_lock: string, onWaiting: () => void) => { onWaiting(); return new Promise<void>((resolve) => { takeOver = resolve; }); },
}));
vi.mock("@ghostly/browser/devices/gate", () => ({ openDeviceGate: async () => ({ full: true }) }));
vi.mock("@ghostly/browser/host", () => ({ setBrowserHost: () => {} }));
vi.mock("@ghostly/browser/platform/sync", () => ({ startSessionSync: () => {} }));
vi.mock("@ghostly/browser/devices/handoffHost", () => ({ setHandoffProfileHost: () => {} }));
vi.mock("../../lib/bootCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootCheck")>()),
  missingEssentials: async () => [],
}));
vi.mock("../../../../web/src/pwa/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/src/pwa/serviceWorker")>()),
  SHARE_FORWARD_AFTER_MS: 300,
  followNewVersion: () => async () => {},
  listenForShares: () => {},
  askForShare: () => {},
}));

/** Each link the app took in, in turn. */
const taken: string[] = [];
vi.mock("../../Root", () => ({
  // The app's intakes, as far as this entry sees them: a link in the address is taken and leaves it.
  Root: function Intakes() {
    useEffect(() => {
      const take = () => {
        const route = linkInAddress(window.location.hash);
        if (route === null) return;
        taken.push(route);
        window.history.replaceState(null, "", "#/");
      };
      take();
      addEventListener("hashchange", take);
      return () => removeEventListener("hashchange", take);
    }, []);
    return null;
  },
}));

const CODE = "ghostly1p" + "q".repeat(211);
const GROUP = "/join/group2/abc";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a tab that waits behind another tab, with two links no tab answered", () => {
  it("opens both once it takes over, the first first", async () => {
    window.history.replaceState(null, "", "/#/");
    document.body.innerHTML = `<div id="root"></div>`;
    vi.stubGlobal("__APP_VERSION__", "0.0.0");
    vi.stubGlobal("__APP_BUILD__", "test");
    void import("../../../../web/src/main");
    await screen.findByText("Ghostly is already open in another tab.", undefined, { timeout: 20_000 });

    window.location.hash = `#/${CODE}`;
    await pause(50);
    window.location.hash = `#${GROUP}`;
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    takeOver();
    await vi.waitFor(() => expect(taken).toEqual([`/${CODE}`, GROUP]));
    expect(window.location.hash).toBe("#/");
  }, 30_000);
});
