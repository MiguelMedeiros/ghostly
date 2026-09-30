import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSettings, loadSettings } from "../../lib/settings";
import { updateFailure } from "../../lib/updateFailure";
import { Settings } from "../../pages/Settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.updates.web

/*
 * "Could not check for updates" says why behind its ⓘ: the reason in words, then the updater's own message as it
 * came. The messages below are Tauri's updater's (tauri-plugin-updater's errors) and the browsers' fetch errors.
 */

describe("why a check failed", () => {
  it("names what the updater's message means", () => {
    const cases: [string, ReturnType<typeof updateFailure>][] = [
      ["error sending request for url (https://github.com/MiguelMedeiros/ghostly/releases/latest/download/latest.json)", "unreachable"],
      ["TypeError: Failed to fetch", "unreachable"],
      ["Load failed", "unreachable"],
      ["error sending request for url (https://github.com/x/latest.json): operation timed out", "timeout"],
      ["Could not fetch a valid release JSON from the remote", "noRelease"],
      ["missing field `version` at line 1 column 2", "noRelease"],
      ["the platform `darwin-aarch64` was not found in the response `platforms` object", "notForThisSystem"],
      ["None of the fallback platforms `[\"linux-x86_64-deb\"]` were found in the response `platforms` object", "notForThisSystem"],
      ["The signature abc could not be decoded, please check if it is a valid base64 string.", "signature"],
      ["The update was signed for version 1.0.0 but the update endpoint announced version 1.0.1.", "signature"],
      ["Invalid signature", "signature"],
      ["Updater does not have any endpoints set.", "unknown"],
    ];
    for (const [message, failure] of cases) expect([message, updateFailure(message, true)]).toEqual([message, failure]);
  });

  it("is being offline, whatever the message, when the device has no network", () => {
    expect(updateFailure("error sending request for url (https://github.com/x)", false)).toBe("offline");
  });
});

describe("Settings → Updates after a failed check", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  function renderSettings(error: string) {
    (fakeEngine as BrowserHost).updates = {
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
      check: () => Promise.reject(new Error(error)),
      install: () => Promise.resolve(),
    };
    // Checked when the button is pressed, not on its own.
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    return renderApp(
      <LockScreenProvider>
        <UpdateProvider>
          <Routes><Route path="/settings" element={<Settings />} /></Routes>
        </UpdateProvider>
      </LockScreenProvider>,
      { route: "/settings" },
    );
  }

  it("says it could not check, with the reason and the updater's words behind the ⓘ", async () => {
    const raw = "error sending request for url (https://github.com/MiguelMedeiros/ghostly/releases/latest/download/latest.json)";
    const { user } = renderSettings(raw);
    await user.click(screen.getByRole("button", { name: "Check now" }));
    const status = await screen.findByText("Could not check for updates");
    const row = status.closest("[data-testid='update-status']")!.parentElement!.parentElement!.parentElement!;
    // The row says only that it failed; the reason waits behind the ⓘ.
    expect(screen.queryByText(/could not be reached/)).toBeNull();
    await user.click(within(row).getByTestId("row-info"));
    expect(within(row).getByTestId("update-failure")).toHaveTextContent("The update server could not be reached. Check your connection.");
    expect(within(row).getByTestId("update-error")).toHaveTextContent(raw);
  });

  it("shows no ⓘ while nothing failed", async () => {
    renderSettings("unused");
    await waitFor(() => expect(screen.getByTestId("update-status")).toBeInTheDocument());
    expect(screen.queryByTestId("update-failure")).toBeNull();
    const row = screen.getByTestId("update-status").parentElement!.parentElement!;
    expect(within(row).queryByTestId("row-info")).toBeNull();
  });
});
