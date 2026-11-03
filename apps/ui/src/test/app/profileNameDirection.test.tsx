import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createProfile, renameProfile } from "../../lib/profiles";
import { Profile } from "../../pages/Profile";
import { Settings } from "../../pages/Settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: profiles.switcher, app.i18n

/*
 * A profile's name is the person's own, in any script, and long enough to be cut. In Arabic a Latin name cut by the
 * line's direction lost its start ("… longue durée"): every place that cuts one lays it out by its own letters
 * (`dir="auto"`), as a chat's name does, so it keeps its start and ends in "…".
 */

const HOME = "Travail de très longue durée";
const WORK = "Work trip planning and more";

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  sessionStorage.clear();
  window.history.replaceState(null, "", "#/");
  renameProfile("", HOME);
  createProfile(WORK);
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.restoreAllMocks();
});

/** The element that shows `name` and cuts it. */
const cut = (root: HTMLElement, name: string) => within(root).getByText(name, { exact: true });

describe("a profile's name in Arabic keeps its own direction where it is cut", () => {
  it("on the account bar and in the switcher: the current one, its name in chats and every other one", async () => {
    const { user } = renderApp(<Routes><Route path="/" element={<AccountBar />} /></Routes>, { language: "ar" });

    const opener = screen.getByTestId("account-profile");
    expect(cut(opener, HOME)).toHaveAttribute("dir", "auto");
    await user.click(opener);
    const menu = screen.getByRole("menu");
    const current = within(menu).getByTestId("profile-switcher-current");
    expect(cut(current, HOME)).toHaveAttribute("dir", "auto");
    // Its name in chats under it too: the person's own words.
    const lines = [...current.querySelectorAll(".truncate")];
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveAttribute("dir", "auto");
    expect(cut(within(menu).getByTestId("profile-switcher-item"), WORK)).toHaveAttribute("dir", "auto");
  });

  it("in the Profile page's list of profiles", () => {
    renderApp(<Profile />, { language: "ar" });
    const rows = screen.getAllByTestId("profile-row");
    expect(cut(rows[0], HOME)).toHaveAttribute("dir", "auto");
    expect(cut(rows[1], WORK)).toHaveAttribute("dir", "auto");
  });

  it("at the top of Settings on a phone", () => {
    windowIs(true);
    renderApp(
      <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
      { route: "/settings", language: "ar" },
    );
    expect(cut(screen.getByTestId("settings-profile-link"), HOME)).toHaveAttribute("dir", "auto");
  });
});
