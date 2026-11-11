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
 * The banner's second line says what pressing its button does ("Updating ends your calls and connections."). It
 * used to give that line to whatever the updater last threw, in the updater's English: a later check that failed
 * (a 502 while a deploy rolls out, a captive portal) put "The update check answered 502" beside Reload, and the
 * warning went. The update found still stands, so the warning stays; an install that fails says why, in words.
 */

describe("the update banner after a failure", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  function host(found: FoundUpdate, install: () => Promise<void> = () => Promise.resolve()) {
    let tell: (() => void) | null = null;
    let calls = 0;
    const check = vi.fn(async () => {
      if (++calls > 1) throw new Error("The update check answered 502");
      return found;
    });
    (fakeEngine as BrowserHost).updates = {
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
      check,
      install,
      onBuildGone: (listener) => { tell = listener; return () => { tell = null; }; },
    };
    saveSettings({ ...loadSettings(), checkForUpdates: true });
    return { check, again: () => tell?.() };
  }

  it("a later check that fails keeps the warning beside Reload, and no updater English", async () => {
    const { check, again } = host({ version: "1.2.0", apply: "reload" });
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    expect(await screen.findByText("Ghostly 1.2.0 is available")).toBeInTheDocument();
    expect(screen.getByText("Updating ends your calls and connections.")).toBeInTheDocument();

    again();
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/answered 502/)).toBeNull();
    expect(screen.getByText("Updating ends your calls and connections.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("an install that fails says why in the app's words, not the updater's", async () => {
    host({ version: "1.2.0", apply: "restart" }, () => Promise.reject(new Error("signature verification failed: invalid encoding in minisign data")));
    renderApp(<UpdateProvider><UpdateBanner /></UpdateProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Update and restart" }));
    expect(await screen.findByText("The update's signature did not check out, so it was not used.")).toBeInTheDocument();
    expect(screen.queryByText(/minisign/)).toBeNull();
  });
});
