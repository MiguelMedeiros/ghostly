import { screen, waitFor } from "@testing-library/react";
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
 * A tab left open across a deploy: the service worker finds a file of its build gone from the server, and the host
 * says so. The app checks at once, past its "checked recently" guard, and the banner offers Reload, named as a new
 * build when it is the same version built again (the web app deploys one version many times).
 */

describe("the host says a file of this build is gone", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  /**
   * A host whose check answers `found` once told, and nothing before. Returns what tells it. `hold` keeps the first
   * check waiting, as a server that has not answered yet; the check reads whether it was told before it waits, as the
   * web host reads `buildGone()` before its fetch.
   */
  function host(found: FoundUpdate, hold?: Promise<void>) {
    let gone = false;
    let tell: (() => void) | null = null;
    const check = vi.fn(async () => {
      const told = gone;
      const wait = hold;
      hold = undefined;
      await wait;
      return told ? found : null;
    });
    (fakeEngine as BrowserHost).updates = {
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
      check,
      install: () => Promise.resolve(),
      onBuildGone: (listener) => { tell = listener; return () => { tell = null; }; },
    };
    saveSettings({ ...loadSettings(), checkForUpdates: true });
    return { check, gone: () => { gone = true; tell?.(); }, listening: () => tell !== null };
  }

  it("checks at once, and the banner offers the new build of this version", async () => {
    const { check, gone, listening } = host({ version: "1.1.4", build: "b2", replaced: true, apply: "reload" });
    const { unmount } = renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    // The load's own check found nothing: the same version is deployed, and only its build differs.
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(listening()).toBe(true);

    gone();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("A new build of Ghostly 1.1.4 is available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    // Gone with the provider: nothing listens after it.
    unmount();
    expect(listening()).toBe(false);
  });

  it("arriving while a check is in flight, the word waits for it: one more check follows, and the banner shows", async () => {
    let answer = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const { check, gone, listening } = host({ version: "1.1.4", build: "b2", replaced: true, apply: "reload" }, held);
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(listening()).toBe(true));
    expect(check).toHaveBeenCalledTimes(1);

    // The load's check is still waiting for the server. It asked before the file went, so it finds nothing.
    gone();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("update-banner")).toBeNull();

    answer();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("A new build of Ghostly 1.1.4 is available")).toBeInTheDocument();
  });

  it("a newer version found this way is named as before", async () => {
    const { gone, listening } = host({ version: "1.1.5", build: "b2", apply: "reload" });
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await waitFor(() => expect(listening()).toBe(true));
    gone();
    expect(await screen.findByText("Ghostly 1.1.5 is available")).toBeInTheDocument();
  });

  it("does nothing while automatic checks are off: the setting is kept, the next Check now still finds it", async () => {
    const { check, listening } = host({ version: "1.1.4", build: "b2", replaced: true, apply: "reload" });
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listening()).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
