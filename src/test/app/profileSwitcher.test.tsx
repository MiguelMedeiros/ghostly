import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ProfileSwitchSplash } from "../../components/ProfileSwitchSplash";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { activeProfileId, createProfile, lastRouteOf, pendingSwitch, prefixOf, renameProfile, settingsKeyFor, type ProfileEntry } from "../../lib/profiles";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: profiles.switcher

/** Where a click in the switcher led, and with what. */
function Landed() {
  const location = useLocation();
  return <p data-testid="landed">{location.pathname}{(location.state as { newProfile?: boolean } | null)?.newProfile ? " +new" : ""}</p>;
}

function renderBar(ui = <AccountBar />) {
  return renderApp(
    <Routes>
      <Route path="/" element={ui} />
      <Route path="*" element={<Landed />} />
    </Routes>,
  );
}

/** A chat of another profile with `messages` messages, `read` of them read: what that profile left unread. */
function chatIn(entry: ProfileEntry, messages: number, read: number) {
  const prefix = prefixOf(entry.id), id = `chat${messages}${read}`;
  localStorage.setItem(`${prefix}${id}`, JSON.stringify({ id, mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: Array.from({ length: messages }, (_, i) => ({ id: `m${i}` })) }));
  localStorage.setItem(`${prefix}read_${id}`, String(read));
}
/** A profile with its own lock turned on. */
function lock(entry: ProfileEntry) {
  const settings = JSON.parse(localStorage.getItem(settingsKeyFor(entry.id)) ?? "{}");
  localStorage.setItem(settingsKeyFor(entry.id), JSON.stringify({ ...settings, lockScreen: { enabled: true, passwordHash: "hash", timeout: 5 } }));
}

const menu = () => screen.getByRole("menu", { name: "Switch profile" });
const others = () => within(menu()).getAllByTestId("profile-switcher-item");

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  sessionStorage.clear();
  window.history.replaceState(null, "", "#/");
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the account switcher on the account bar", () => {
  it("lists the active profile first and marked, then Add a profile and Manage profiles", async () => {
    renameProfile("", "Personal");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ defaultNickname: "Miguel" }));
    const { user } = renderBar();

    const opener = screen.getByTestId("account-profile");
    expect(opener).toHaveAttribute("aria-haspopup", "menu");
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(opener).toHaveAttribute("aria-keyshortcuts", "Alt+Shift+P");
    await user.click(opener);
    expect(opener).toHaveAttribute("aria-expanded", "true");

    const current = within(menu()).getByTestId("profile-switcher-current");
    expect(current).toHaveAttribute("role", "menuitem");
    expect(current).toHaveAccessibleName("Personal, Miguel, current profile. Open profile");
    expect(within(menu()).queryAllByTestId("profile-switcher-item")).toHaveLength(0);
    expect(within(menu()).getByRole("menuitem", { name: "Add a profile" })).toBeInTheDocument();
    expect(within(menu()).getByRole("menuitem", { name: "Manage profiles" })).toBeInTheDocument();
    // Only one profile: nothing to point at on the Profile picture.
    expect(screen.queryByTestId("account-profile-others")).not.toBeInTheDocument();
  });

  it("shows each other profile with what it left unread, and a locked one only as locked", async () => {
    const work = createProfile("Work"), family = createProfile("Family");
    chatIn(work, 5, 2);
    chatIn(work, 1, 1);
    chatIn(family, 4, 0);
    lock(family);
    const { user } = renderBar();

    // Something unread in another profile: a ring on the Profile picture, and its name says so.
    expect(await screen.findByTestId("account-profile-others")).toBeInTheDocument();
    expect(screen.getByTestId("account-profile")).toHaveAccessibleName(/unread messages in another profile/);

    await user.click(screen.getByTestId("account-profile"));
    const [workItem, familyItem] = others();
    expect(workItem).toHaveAttribute("aria-checked", "false");
    expect(workItem).toHaveAccessibleName("Switch to Work, 3 unread");
    expect(within(workItem).getByTestId("profile-switcher-unread")).toHaveTextContent("3");
    // Being able to open this profile does not open the others: no count, no picture of a locked one.
    expect(familyItem).toHaveAccessibleName("Switch to Family, locked");
    expect(within(familyItem).queryByTestId("profile-switcher-unread")).not.toBeInTheDocument();
    expect(within(familyItem).getByTestId("profile-switcher-locked")).toBeInTheDocument();
  });

  it("switches in one tap: the other profile becomes active, this one keeps its place, and the overlay says which", async () => {
    const work = createProfile("Work");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    renderBar(<><AccountBar /><LockScreenProvider><ProfileSwitchSplash /></LockScreenProvider></>);
    window.history.replaceState(null, "", "#/wallet");
    // The reload itself is left out: the test stays on this page.
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, hash: "#/wallet", reload } as Location);

    fireEvent.click(screen.getByTestId("account-profile"));
    fireEvent.click(others()[0]);

    expect(lastRouteOf("")).toBe("/wallet");
    expect(pendingSwitch()).toMatchObject({ id: work.id, name: "Work" });
    expect(screen.getByTestId("profile-switch-splash")).toHaveTextContent("Opening Work…");
    // Under the overlay this page is still Personal until the moment it reloads as Work.
    expect(activeProfileId()).toBe("");
    act(() => { vi.advanceTimersByTime(100); });
    expect(activeProfileId()).toBe(work.id);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("opens from the keyboard (Alt+Shift+P), moves with the arrows and gives the focus back on Escape", async () => {
    createProfile("Work");
    createProfile("Family");
    const { user } = renderBar();
    const before = screen.getByTestId("account-settings");
    before.focus();

    await user.keyboard("{Alt>}{Shift>}P{/Shift}{/Alt}");
    const items = [...menu().querySelectorAll<HTMLElement>("[role^=menuitem]")];
    expect(items.map((item) => item.textContent)).toEqual([expect.stringContaining("Personal"), "WWork", "FFamily", "+Add a profile", "Manage profiles"]);
    // The first other profile has the focus: the likeliest next step.
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[4]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items[4]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(before).toHaveFocus();
  });

  it("opens on a click on Profile, closes on a click outside or a second click, and its first entry is the Profile page", async () => {
    const { user } = renderBar();
    await user.click(screen.getByTestId("account-profile"));
    expect(menu()).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("account-profile"));
    expect(menu()).toBeInTheDocument();
    await user.click(screen.getByTestId("account-profile"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("landed")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("account-profile"));
    await user.click(within(menu()).getByTestId("profile-switcher-current"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent(/^\/profile$/);
  });

  it("Add a profile opens Profile with the form open; Manage profiles opens Profile", async () => {
    const { user, unmount } = renderBar();
    await user.click(screen.getByTestId("account-profile"));
    await user.click(within(menu()).getByRole("menuitem", { name: "Add a profile" }));
    expect(screen.getByTestId("landed")).toHaveTextContent("/profile +new");
    unmount();

    const again = renderBar();
    await again.user.click(screen.getByTestId("account-profile"));
    await again.user.click(within(menu()).getByRole("menuitem", { name: "Manage profiles" }));
    expect(screen.getByTestId("landed")).toHaveTextContent(/^\/profile$/);
  });

  it("is not offered where the client has one profile only: Profile is the page, with no menu", async () => {
    fakeEngine.features = { ...fakeEngine.features, profiles: false };
    const { user } = renderBar();
    expect(screen.getByTestId("account-profile")).not.toHaveAttribute("aria-haspopup");
    await user.keyboard("{Alt>}{Shift>}P{/Shift}{/Alt}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("account-profile"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByTestId("landed")).toHaveTextContent("/profile");
  });
});

describe("the account switcher on a phone", () => {
  it("carries the active profile on the Settings tab and opens as a sheet on a long press", () => {
    const work = createProfile("Work");
    chatIn(work, 2, 0);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    renderBar(<MobileTabBar />);
    const tab = screen.getByTestId("mobile-tab-settings");
    expect(screen.getByTestId("mobile-tab-profile")).toBeInTheDocument();
    expect(tab).toHaveAttribute("aria-haspopup", "menu");

    // A short tap is Settings; holding it is the switcher.
    fireEvent.pointerDown(tab, { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(tab, { pointerType: "touch" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.pointerDown(tab, { pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(menu()).toHaveClass("profile-switcher-sheet");
    expect(screen.getByTestId("profile-switcher-backdrop")).toBeInTheDocument();
    // The tap that ends the long press does not also open Settings.
    fireEvent.pointerUp(tab, { pointerType: "touch" });
    fireEvent.click(tab);
    expect(screen.queryByTestId("landed")).not.toBeInTheDocument();
  });
});

describe("the switch overlay after the reload", () => {
  it("shows the profile being opened, then lets go once its peer is there", () => {
    sessionStorage.setItem("ghostly_switching", JSON.stringify({ id: "", name: "Personal", color: "#22d3ee", at: Date.now() }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    renderApp(<LockScreenProvider><ProfileSwitchSplash /></LockScreenProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Opening Personal…");
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId("profile-switch-splash")).toHaveAttribute("data-leaving");
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId("profile-switch-splash")).not.toBeInTheDocument();
    expect(pendingSwitch()).toBeNull();
  });
});

describe("where a profile reopens", () => {
  it("is a place, never an address that carries keys", () => {
    localStorage.setItem(`${prefixOf("")}last_route`, "/chat/abc123");
    expect(lastRouteOf("")).toBe("/chat/abc123");
    localStorage.setItem(`${prefixOf("")}last_route`, "/chat/seed/key/enc");
    expect(lastRouteOf("")).toBe("/");
    localStorage.setItem(`${prefixOf("")}last_route`, "/join/group1/secret");
    expect(lastRouteOf("")).toBe("/");
  });
});
