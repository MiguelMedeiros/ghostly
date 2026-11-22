import { fireEvent, screen, waitFor } from "@testing-library/react";
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
 * Reload waits for the new worker (Desktop downloads) for a while. A check that starts or settles meanwhile, from the
 * build-gone word of a deploy, `online` or the interval, must not put the banner back to ready: "Updating..." stays,
 * and Reload stays busy, so a second press starts no second install.
 */

describe("an update check while Reload installs", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  const found: FoundUpdate = { version: "1.1.4", build: "b2", replaced: true, apply: "reload" };

  /** A host whose checks find `found`, the first one held until `answer`, and whose install never ends (the page goes). */
  function host() {
    let answer = () => {};
    let hold: Promise<void> | undefined = new Promise<void>((resolve) => { answer = resolve; });
    let tell: (() => void) | null = null;
    const check = vi.fn(async () => {
      const wait = hold;
      hold = undefined;
      await wait;
      return found;
    });
    const install = vi.fn(() => new Promise<void>(() => {}));
    (fakeEngine as BrowserHost).updates = {
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
      check,
      install,
      onBuildGone: (listener) => { tell = listener; return () => { tell = null; }; },
    };
    saveSettings({ ...loadSettings(), checkForUpdates: true });
    return { check, install, answer: () => answer(), gone: () => tell?.() };
  }

  it("a check started while it installs leaves it installing, and Reload starts no second install", async () => {
    const { check, install, answer, gone } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    answer();
    const reload = await screen.findByRole("button", { name: "Reload" });

    fireEvent.click(reload);
    expect(await screen.findByTestId("update-banner")).toHaveTextContent("Updating...");
    expect(install).toHaveBeenCalledTimes(1);

    // A deploy's build-gone word comes while the new worker is awaited.
    gone();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("update-banner")).toHaveTextContent("Updating...");
    expect(reload).toHaveAttribute("aria-busy", "true");
    fireEvent.click(reload);
    expect(install).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a check already out when Reload is pressed settles without undoing the install", async () => {
    const { install, answer, gone } = host();
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    // The load's check finds the update; then a build-gone word starts a second, which the server holds.
    answer();
    const reload = await screen.findByRole("button", { name: "Reload" });
    let release = () => {};
    const { updates } = fakeEngine as BrowserHost;
    vi.mocked(updates!.check).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(found); }));
    gone();
    await waitFor(() => expect(updates!.check).toHaveBeenCalledTimes(2));

    fireEvent.click(reload);
    expect(await screen.findByTestId("update-banner")).toHaveTextContent("Updating...");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("update-banner")).toHaveTextContent("Updating...");
    expect(reload).toHaveAttribute("aria-busy", "true");
    expect(install).toHaveBeenCalledTimes(1);
  });
});
