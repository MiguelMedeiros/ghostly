import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import type { ProfileOpenFailure } from "@ghostly/browser/shared/idb";
import { ProfileGate } from "../../components/ProfileUnavailable";
import { UpdateBanner } from "../../components/UpdateBanner";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import type { FoundUpdate } from "../../lib/updates";
import { loadSettings, saveSettings } from "../../lib/settings";
import { Settings } from "../../pages/Settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.updates.web

/*
 * Check now, and Update and restart, pressed from the keyboard: the focus stays on the button while it works, and is on
 * the button in its place once it is done (Check now again, or the update's own button). A disabled button drops a
 * keyboard's focus to the page in Chrome and WebKit, and the next Tab started from the top.
 */

/** What Chrome and WebKit do to a focused button that turns disabled: they take its focus away. happy-dom keeps it. */
function browserDropsFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement && active.disabled) act(() => { active.disabled = false; active.blur(); active.disabled = true; });
}

/** A host whose check and install wait until let go. */
function host() {
  let answer: (found: FoundUpdate | null) => void = () => {};
  let installed: () => void = () => {};
  (fakeEngine as BrowserHost).updates = {
    downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases",
    check: () => new Promise((resolve) => { answer = resolve; }),
    install: () => new Promise((resolve) => { installed = resolve; }),
  };
  saveSettings({ ...loadSettings(), checkForUpdates: false });
  return { answer: (found: FoundUpdate | null) => act(async () => { answer(found); }), installed: () => installed() };
}

const RESTART: FoundUpdate = { version: "9.9.9", apply: "restart" };
const MANUAL: FoundUpdate = { version: "9.9.9", apply: "manual" };

afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

describe("Settings → Updates, from the keyboard", () => {
  function renderSettings() {
    return renderApp(
      <LockScreenProvider>
        <UpdateProvider>
          <Routes><Route path="/settings" element={<Settings />} /></Routes>
        </UpdateProvider>
      </LockScreenProvider>,
      { route: "/settings" },
    );
  }

  it("Check now keeps the focus while it checks, and has it again when nothing was found", async () => {
    const { answer } = host();
    const { user } = renderSettings();
    const button = screen.getByRole("button", { name: "Check now" });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(button).toHaveTextContent("Checking"));
    browserDropsFocus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    await answer(null);
    browserDropsFocus();
    expect(screen.getByRole("button", { name: "Check now" })).toHaveFocus();
  });

  it("an update found: the focus is on Update and restart, and stays there while it installs", async () => {
    const { answer, installed } = host();
    const { user } = renderSettings();
    screen.getByRole("button", { name: "Check now" }).focus();
    await user.keyboard("{Enter}");
    browserDropsFocus();
    await answer(RESTART);
    browserDropsFocus();
    const restart = screen.getByRole("button", { name: /Update and restart/ });
    expect(restart).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(restart).toHaveTextContent("Updating"));
    browserDropsFocus();
    expect(restart).toHaveFocus();
    installed();
  });
});

describe("the update banner above the list, from the keyboard and a screen reader", () => {
  /** The banner over the list's search field, the app checking on its own. `before` runs while the check is out. */
  async function renderBanner(found: FoundUpdate, before?: () => void) {
    const { answer, installed } = host();
    saveSettings({ ...loadSettings(), checkForUpdates: true });
    const view = renderApp(<UpdateProvider><UpdateBanner /><input type="search" aria-label="Search" /></UpdateProvider>);
    before?.();
    await answer(found);
    await screen.findByTestId("update-banner");
    return { ...view, installed };
  }

  it("is said politely when it comes, from a line in the page before it", async () => {
    await renderBanner(RESTART, () => expect(screen.getByRole("status")).toBeEmptyDOMElement());
    expect(screen.getByRole("status")).toHaveTextContent("Ghostly 9.9.9 is available");
  });

  it("Update and restart keeps the focus while it installs", async () => {
    const { user, installed } = await renderBanner(RESTART);
    const restart = screen.getByRole("button", { name: /Update and restart/ });
    restart.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("update-banner")).toHaveTextContent("Updating"));
    browserDropsFocus();
    expect(restart).toHaveFocus();
    expect(restart).toHaveAttribute("aria-busy", "true");
    installed();
  });

  it("Later hands the focus on to what comes next, not to the page", async () => {
    const { user } = await renderBanner(RESTART);
    screen.getByRole("button", { name: "Later" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveFocus();
  });
});

describe("a profile last used by a newer Ghostly: its update button, from the keyboard", () => {
  const NEWER: ProfileOpenFailure = { reason: "newer", supportedVersion: 11, storedVersion: 12 };
  function renderGate() {
    const view = renderApp(<UpdateProvider><ProfileGate><div /></ProfileGate></UpdateProvider>);
    act(() => fakeEngine.emit({ kind: "start-failed", failure: NEWER }));
    return view;
  }

  it("Check keeps the focus while it checks, and has it again when nothing was found", async () => {
    const { answer } = host();
    const { user } = renderGate();
    const button = screen.getByTestId("profile-unavailable-check");
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(button).toHaveTextContent("Checking"));
    browserDropsFocus();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    await answer(null);
    browserDropsFocus();
    expect(screen.getByTestId("profile-unavailable-no-update")).toBeInTheDocument();
    expect(screen.getByTestId("profile-unavailable-check")).toHaveFocus();
  });

  it("an update found: the focus is on its button, and stays there while it installs", async () => {
    const { answer, installed } = host();
    const { user } = renderGate();
    screen.getByTestId("profile-unavailable-check").focus();
    await user.keyboard("{Enter}");
    browserDropsFocus();
    await answer(RESTART);
    browserDropsFocus();
    const update = screen.getByTestId("profile-unavailable-update");
    expect(update).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(update).toHaveTextContent("Updating"));
    browserDropsFocus();
    expect(update).toHaveFocus();
    expect(update).toHaveAttribute("aria-busy", "true");
    installed();
  });

  it("an update this client only links to: the focus is on Download", async () => {
    const { answer } = host();
    const { user } = renderGate();
    screen.getByTestId("profile-unavailable-check").focus();
    await user.keyboard("{Enter}");
    browserDropsFocus();
    await answer(MANUAL);
    expect(screen.getByTestId("profile-unavailable-update")).toHaveFocus();
  });
});
