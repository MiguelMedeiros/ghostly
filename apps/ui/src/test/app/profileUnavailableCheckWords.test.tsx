import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import type { ProfileOpenFailure } from "@ghostly/browser/shared/idb";
import { ProfileGate } from "../../components/ProfileUnavailable";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSettings, saveSettings } from "../../lib/settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.updates.web

/*
 * A profile last used by a newer Ghostly offers Check now. A check that failed showed what the browser threw, as it
 * threw it ("Failed to fetch", "The update check answered 502"), in English in every language. It says why in the
 * app's words, as Settings does.
 */

describe("a profile last used by a newer Ghostly: a check that fails", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  it("says why in the app's words, not the browser's", async () => {
    (fakeEngine as BrowserHost).updates = {
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
      check: () => Promise.reject(new TypeError("Failed to fetch")),
      install: () => Promise.resolve(),
    };
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    const NEWER: ProfileOpenFailure = { reason: "newer", supportedVersion: 11, storedVersion: 12 };
    const { user } = renderApp(<UpdateProvider><ProfileGate><div /></ProfileGate></UpdateProvider>);
    act(() => fakeEngine.emit({ kind: "start-failed", failure: NEWER }));
    await user.click(await screen.findByTestId("profile-unavailable-check"));
    expect(await screen.findByText("The update server could not be reached. Check your connection.")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });
});
