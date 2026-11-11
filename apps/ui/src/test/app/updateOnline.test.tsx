import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import type { FoundUpdate } from "../../lib/updates";
import { UpdateBanner } from "../../components/UpdateBanner";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSettings, saveSettings } from "../../lib/settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.updates.web

/*
 * The installed web app opened with no network, or one that lost it when a check was due: the check is skipped, and
 * once the device is back online it looks at once, instead of waiting for the tab to be hidden and shown again or for
 * the next scheduled check hours later. A network that flaps starts no pile of checks.
 */

const STALE_MS = 30 * 60 * 1000;
const NEW_BUILD: FoundUpdate = { version: "1.1.4", build: "b2", replaced: true, apply: "reload" };

/** What the device says about its network, changed by the test; `online()`/`offline()` also fire the event. */
function network(start: boolean | undefined) {
  let value = start;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => value as boolean);
  return {
    online: () => act(() => { value = true; window.dispatchEvent(new Event("online")); }),
    offline: () => act(() => { value = false; window.dispatchEvent(new Event("offline")); }),
  };
}

/**
 * A host whose check answers `found` once the build was said gone, and null before. Each check waits for `answer()`
 * when `held` is set, as a server that has not answered yet. `fail()` makes the next check throw.
 */
function host(found: FoundUpdate | null = null, held = false) {
  let gone = false;
  let fail = false;
  let tell: (() => void) | null = null;
  const pending: Array<() => void> = [];
  const check = vi.fn(async () => {
    const told = gone;
    if (held) await new Promise<void>((resolve) => pending.push(resolve));
    if (fail) { fail = false; throw new Error("Failed to fetch"); }
    return told ? found : null;
  });
  (fakeEngine as BrowserHost).updates = {
    downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
    check,
    install: () => Promise.resolve(),
    onBuildGone: (listener) => { tell = listener; return () => { tell = null; }; },
  };
  saveSettings({ ...loadSettings(), checkForUpdates: true });
  return {
    check,
    gone: () => act(() => { gone = true; tell?.(); }),
    failNext: () => { fail = true; },
    answer: () => act(async () => { pending.shift()?.(); }),
    listening: () => tell !== null,
  };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

afterEach(() => {
  delete (fakeEngine as BrowserHost).updates;
  vi.restoreAllMocks();
});

describe("automatic update checks and the network coming back", () => {
  it("opened offline: no check, and one check as soon as the device is back online", async () => {
    const net = network(false);
    const { check, listening } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(listening()).toBe(true));
    await settle();
    expect(check).not.toHaveBeenCalled();

    net.online();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("back online soon after a check that answered: nothing to look at again", async () => {
    const net = network(true);
    const { check } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await settle();

    net.offline();
    net.online();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("back online long after the last answer: it looks again", async () => {
    const net = network(true);
    const { check } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await settle();

    const later = Date.now() + STALE_MS + 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    net.offline();
    net.online();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  });

  it("a network that flaps: one check at a time, and none once it has answered", async () => {
    const net = network(false);
    const { check, answer } = host(null, true);
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await settle();
    expect(check).not.toHaveBeenCalled();

    net.online();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    // The server has not answered yet; the network comes and goes.
    for (let i = 0; i < 5; i++) { net.offline(); net.online(); }
    await settle();
    expect(check).toHaveBeenCalledTimes(1);

    await answer();
    await settle();
    net.offline();
    net.online();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a check that failed because the network went: back online, it asks again however recent the last answer", async () => {
    const net = network(true);
    const { check, answer, failNext } = host(null, true);
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await answer();
    await settle();

    // Hidden and shown long after: a second check goes out, and the network drops while it waits.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALE_MS + 1000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    vi.mocked(Date.now).mockRestore();
    net.offline();
    failNext();
    await answer();
    await settle();

    net.online();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(3));
  });

  it("the build said gone while offline: the check waits for the network, and the banner offers Reload", async () => {
    const net = network(true);
    const { check, gone, listening } = host(NEW_BUILD);
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listening()).toBe(true));
    await settle();

    net.offline();
    gone();
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-banner")).toBeNull();

    // The last answer is minutes old, but the word that the build is gone has not been looked at yet.
    net.online();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("A new build of Ghostly 1.1.4 is available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("only a clear \"offline\" counts: a browser that doesn't say checks at once", async () => {
    network(undefined);
    const { check } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  });

  it("gone with the provider, or with automatic checks off: coming back online asks nobody", async () => {
    const net = network(false);
    const { check } = host();
    const { unmount } = renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await settle();
    unmount();
    net.online();
    await settle();
    expect(check).not.toHaveBeenCalled();

    net.offline();
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await settle();
    net.online();
    await settle();
    expect(check).not.toHaveBeenCalled();
  });
});
