import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { dropLinks, takeLinks } from "../../lib/otherTabLink";

// covers: app.single-peer-per-browser

/*
 * The web app's entry (apps/web/src/main.tsx) in a tab that waits behind another tab of its profile: a link that
 * reaches it while it waits (the installed app sends a `web+ghostly:` link to the window used last, or one is pasted
 * into the address bar) goes to the tab that holds the profile and leaves this tab's address, as one it opened with.
 */

vi.mock("@ghostly/browser/inPageHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/inPageHost")>()),
  // Another tab holds the lock, for as long as the test runs.
  becomeThePeer: (_lock: string, onWaiting: () => void) => { onWaiting(); return new Promise<never>(() => {}); },
}));
vi.mock("../../lib/bootCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootCheck")>()),
  missingEssentials: async () => [],
}));
vi.mock("../../../../web/src/pwa/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/src/pwa/serviceWorker")>()),
  SHARE_FORWARD_AFTER_MS: 20,
}));

const CODE = "ghostly1p" + "q".repeat(211);
const GROUP = "/join/group2/abc";

describe("a tab that waits behind another tab", () => {
  it("hands on a link that reaches it while it waits, and takes it out of its address", async () => {
    window.history.replaceState(null, "", "/#/");
    document.body.innerHTML = `<div id="root"></div>`;
    vi.stubGlobal("__APP_VERSION__", "0.0.0");
    vi.stubGlobal("__APP_BUILD__", "test");
    const open = vi.fn();
    let holder = takeLinks("ghostly-peer", open);
    // The entry never settles here: it waits for a lock it never gets.
    void import("../../../../web/src/main");
    await screen.findByText("Ghostly is already open in another tab.", undefined, { timeout: 20_000 });

    window.location.hash = `#/${CODE}`;
    await vi.waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(`/${CODE}`));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    await screen.findByText("Your link opened in Ghostly in your other tab.");

    // The next one too.
    window.location.hash = `#${GROUP}`;
    await vi.waitFor(() => expect(open).toHaveBeenLastCalledWith(GROUP));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(open).toHaveBeenCalledTimes(2);

    // That tab on standby refuses it: it leaves this address all the same, and nothing says it opened.
    holder();
    holder = dropLinks("ghostly-peer");
    window.location.hash = `#/${CODE}`;
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    await screen.findByText("Ghostly is already open in another tab.");
    expect(open).toHaveBeenCalledTimes(2);

    // A page of the app is no link: it stays.
    window.location.hash = "#/settings";
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(window.location.hash).toBe("#/settings");
    holder();
  }, 30_000);
});
