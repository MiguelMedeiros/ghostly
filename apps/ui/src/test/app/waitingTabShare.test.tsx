import { expect, it, vi } from "vitest";

// covers: app.pwa.share-target

/*
 * The web app's entry (apps/web/src/main.tsx) in a tab opened for a share, with a link reaching it while it still
 * starts (its profile, its words, what the browser has): its address leaves the picker's before it asks for the lock.
 * No other tab runs the app, so this one gets the lock at once, and asks the worker for the share it opened for,
 * whatever its address says by then.
 */

const CODE = vi.hoisted(() => "ghostly1p" + "q".repeat(211));

vi.mock("@ghostly/browser/inPageHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ghostly/browser/inPageHost")>()),
  // No other tab holds the lock: it is this tab's at once.
  becomeThePeer: async () => {},
}));
vi.mock("../../lib/bootCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bootCheck")>()),
  // The link comes while the entry awaits, before it asks for the lock.
  missingEssentials: async () => { window.location.hash = `#/${CODE}`; return []; },
}));
// The app itself is not what this is about.
vi.mock("../../Root", () => ({ Root: () => null }));
const askForShare = vi.hoisted(() => vi.fn());
vi.mock("../../../../web/src/pwa/serviceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../web/src/pwa/serviceWorker")>()),
  askForShare,
}));

it("a tab opened for a share that a link reaches as it starts asks the worker for the share", async () => {
  window.history.replaceState(null, "", "/#/shared");
  document.body.innerHTML = `<div id="root"></div>`;
  vi.stubGlobal("__APP_VERSION__", "0.0.0");
  vi.stubGlobal("__APP_BUILD__", "test");
  void import("../../../../web/src/main");

  await vi.waitFor(() => expect(askForShare).toHaveBeenCalledOnce(), { timeout: 20_000 });
  expect(window.location.hash).toBe(`#/${CODE}`);
  expect(askForShare).toHaveBeenCalledWith(true);
}, 40_000);
