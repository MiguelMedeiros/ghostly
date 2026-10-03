import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import type { ProfileOpenFailure } from "@ghostly/browser/shared/idb";
import { ProfileGate } from "../../components/ProfileUnavailable";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSettings, loadSettings } from "../../lib/settings";
import { createProfile } from "../../lib/profiles";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.profile-unavailable

/*
 * The notice in place of the app when the peer did not start because the profile's database did not open. Reported
 * 2026-10-02: a profile opened once by a build with a newer database, then by the released app, showed its chat list
 * (drawn from the page's mirror) over an engine that never started: nobody connected, nothing sent, no error.
 */

const NEWER: ProfileOpenFailure = { reason: "newer", supportedVersion: 11, storedVersion: 12, detail: "VersionError: The requested version (11) is less than the existing version (12)." };

function renderGate(language?: "pt") {
  return renderApp(
    <UpdateProvider>
      <ProfileGate>
        <div data-testid="the-app"><input placeholder="Message…" /></div>
      </ProfileGate>
    </UpdateProvider>,
    { language },
  );
}
const fail = (failure: ProfileOpenFailure) => act(() => fakeEngine.emit({ kind: "start-failed", failure }));

describe("a profile that cannot be opened", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  it("last used by a newer Ghostly: one short line in place of the app, the versions behind its ⓘ, and nothing to type into or delete", async () => {
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    const view = renderGate();
    expect(screen.getByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-unavailable")).toBeNull();

    fail(NEWER);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveAttribute("data-testid", "profile-unavailable");
    expect(notice).toHaveTextContent("This profile was last used by a newer version of Ghostly.");
    expect(notice).toHaveTextContent("Update the app to open it.");
    // The app is not there at all: no list to open, no composer whose message would go nowhere.
    expect(screen.queryByTestId("the-app")).toBeNull();
    expect(screen.queryByPlaceholderText("Message…")).toBeNull();
    // Nothing offers to delete, reset or clear: the data is whole.
    expect(notice.textContent).not.toMatch(/delete|reset|clear|remove/i);
    expect(screen.queryByRole("button", { name: /delete|reset|clear|remove/i })).toBeNull();

    // The versions are behind the ⓘ, not in the line.
    expect(screen.queryByTestId("profile-unavailable-text")).toBeNull();
    expect(notice).not.toHaveTextContent("version 12");
    const more = screen.getByRole("button", { name: "More info" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await view.user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const story = screen.getByTestId("profile-unavailable-text");
    expect(story).toHaveTextContent("This profile's data is at version 12. This app, Ghostly 0.0.0-test, reads up to version 11.");
    expect(story).toHaveTextContent("nothing was changed or deleted: your chats, keys and wallets are still there");

    // Looking for the newer version is one press away; a client with none out yet says what else opens the profile.
    await view.user.click(screen.getByTestId("profile-unavailable-check"));
    expect(await screen.findByTestId("profile-unavailable-no-update")).toHaveTextContent("No newer version is out yet. Open this profile with the app that used it last.");
  });

  it("offers the newer version where one is out, with the client's own way of putting it in place", async () => {
    const install = vi.fn(async () => {});
    (fakeEngine as BrowserHost).updates = { downloadUrl: "https://example.test/releases", check: async () => ({ version: "9.9.9", apply: "restart" }), install };
    const view = renderGate();
    fail(NEWER);
    const update = await screen.findByTestId("profile-unavailable-update");
    expect(update).toHaveTextContent("Update and restart");
    await view.user.click(update);
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it("says a stored version it could not read as above this app's", async () => {
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    const view = renderGate();
    fail({ reason: "newer", supportedVersion: 11 });
    await view.user.click(screen.getByRole("button", { name: "More info" }));
    expect(screen.getByTestId("profile-unavailable-text")).toHaveTextContent("This profile's data is at version >11.");
  });

  it("any other failure: that the data did not open, the reason and what to try, the system's words behind the ⓘ, and Try again", async () => {
    const view = renderGate();
    const cases: [ProfileOpenFailure["reason"], string, string][] = [
      ["blocked", "Another Ghostly window or tab still has it open with an older version.", "Close the other Ghostly windows and tabs, then try again."],
      ["full", "This device is out of storage space.", "Free some space, then try again."],
      ["denied", "This browser gives Ghostly no storage here: a private window, or storage blocked for this site.", "Use a normal window or allow storage for this site, then try again."],
      ["failed", "The data did not open, and the system gave no clear reason.", "Restart the app or the device, then try again."],
    ];
    for (const [reason, why, what] of cases) {
      fail({ reason, supportedVersion: 11, detail: "UnknownError: Internal error opening backing store" });
      const notice = screen.getByTestId("profile-unavailable");
      expect(notice).toHaveAttribute("data-reason", reason);
      expect(notice).toHaveTextContent("Ghostly could not open this profile's data.");
      expect(screen.getByTestId("profile-unavailable-reason")).toHaveTextContent(why);
      expect(notice).toHaveTextContent(what);
      expect(notice).not.toHaveTextContent("newer version");
      expect(screen.getByTestId("profile-unavailable-retry")).toHaveTextContent("Try again");
      expect(screen.queryByTestId("profile-unavailable-check")).toBeNull();
      expect(notice.textContent).not.toMatch(/delete the|reset|clear (all|the|data)|remove/i);
    }
    await view.user.click(screen.getByRole("button", { name: "More info" }));
    const story = screen.getByTestId("profile-unavailable-text");
    expect(story).toHaveTextContent("Nothing was changed or deleted. While the data is closed, Ghostly connects to nobody and sends nothing for this profile.");
    expect(story).toHaveTextContent("What the system said: UnknownError: Internal error opening backing store");
  });

  it("is said in the app's language", () => {
    renderGate("pt");
    fail(NEWER);
    expect(screen.getByTestId("profile-unavailable")).toHaveTextContent("Este perfil foi usado por último em uma versão mais nova do Ghostly.");
    expect(screen.getByTestId("profile-unavailable")).toHaveTextContent("Atualize o app para abri-lo.");
  });

  it("does not keep the person out of their other profiles", () => {
    const other = createProfile("Work");
    renderGate();
    fail(NEWER);
    expect(screen.getByTestId("profile-unavailable-switch")).toHaveTextContent(`Switch to ${other.name}`);
  });

  it("goes when a peer that runs sends its state (the extension's, started again)", () => {
    renderGate();
    fail(NEWER);
    expect(screen.queryByTestId("the-app")).toBeNull();
    act(() => fakeEngine.setState({}));
    expect(screen.getByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-unavailable")).toBeNull();
  });
});
