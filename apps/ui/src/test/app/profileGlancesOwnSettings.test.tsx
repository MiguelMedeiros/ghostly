import "fake-indexeddb/auto";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileBadge } from "../../components/ProfileBadge";
import { useSettings } from "../../contexts/SettingsContext";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { useProfileGlances } from "../../hooks/useProfileSwitcher";
import { createProfile, prefixOf, renameProfile, setRunningProfile, THEME_COLOR } from "../../lib/profiles";
import type { ChatSession } from "../../lib/types";
import { Profile } from "../../pages/Profile";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: profiles.switcher, settings.nickname

/*
 * A save of this profile's settings (each key typed in its name, a switch) can't change what the other profiles hold:
 * the switcher's glances of them are not read again for it, and the Settings and Profile pages draw once per change.
 * A change of another profile (added, renamed) still reaches the glances, and this profile's colour still reaches
 * its badge.
 */

const draws = vi.hoisted(() => ({ glances: 0, nameField: 0 }));

// One per drawing of a component that shows the glances (here the Settings page).
vi.mock("../../hooks/useProfileSwitcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useProfileSwitcher")>();
  return { ...actual, useProfileGlances: () => { draws.glances++; return actual.useProfileGlances(); } };
});

// One per drawing of a page holding the name field (here the Profile page).
vi.mock("../../hooks/useOwnNameField", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useOwnNameField")>();
  return { ...actual, useOwnNameField: () => { draws.nameField++; return actual.useOwnNameField(); } };
});

const chat = (id: string, unread: number): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", createdAt: 1,
  messages: Array.from({ length: unread }, (_, i) => ({ id: `m${i}`, text: "hi", sender: "peer", timestamp: 1 + i })),
});
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
/** A colour as the page's style holds it. */
const colour = (hex: string) => { const probe = document.createElement("span"); probe.style.background = hex; return probe.style.background; };
/** Three other profiles, each with a few chats waiting. */
const others = () => ["Work", "Family", "Club"].map((name) => {
  const entry = createProfile(name);
  for (let c = 0; c < 5; c++) localStorage.setItem(`${prefixOf(entry.id)}c${c}`, JSON.stringify(chat(`c${c}`, 1)));
  return entry;
});
const page = (element: React.ReactElement, route: string) =>
  renderApp(<LockScreenProvider><UpdateProvider>{element}</UpdateProvider></LockScreenProvider>, { route });

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); setRunningProfile(undefined); });

describe("this profile's own settings saves", () => {
  it("typing a name in Settings draws the page once per key and reads none of the other profiles", async () => {
    others();
    const { user } = page(<Settings />, "/settings");
    await settle();
    const field = document.getElementById("settings-nickname") as HTMLInputElement;
    field.focus();
    await settle();

    const listed = vi.spyOn(indexedDB, "databases");
    const opened = vi.spyOn(indexedDB, "open");
    draws.glances = 0;
    await user.type(field, "Miguelito12");
    await settle();

    expect(field.value).toBe("Miguelito12");
    expect([listed.mock.calls.length, opened.mock.calls.length], "databases listed / opened for the other profiles' glances").toEqual([0, 0]);
    expect(draws.glances, "Settings page draws for 11 keys").toBeLessThanOrEqual(11);
  });

  it("typing a name on the Profile page draws the page once per key", async () => {
    others();
    const { user } = page(<Profile />, "/profile");
    const field = await screen.findByTestId("account-nickname");
    field.focus();
    await settle();

    draws.nameField = 0;
    await user.type(field, "Miguelito12");
    await settle();

    expect((field as HTMLInputElement).value).toBe("Miguelito12");
    expect(draws.nameField, "Profile page draws for 11 keys").toBeLessThanOrEqual(11);
  });

  it("a new colour of this profile still reaches its badge where the glances are shown", async () => {
    let settings: ReturnType<typeof useSettings> | undefined;
    const Grab = () => { settings = useSettings(); return null; };
    // Draws only when the glances change, as the phone's tab bar does after its parent drew with the old colour.
    const Badge = () => <ProfileBadge entry={useProfileGlances().current} />;
    renderApp(<><Grab /><Badge /></>);
    await settle();
    const badge = document.querySelector("[data-initial]") as HTMLElement;

    act(() => settings!.updateColorTheme("purple"));
    await settle();
    expect(badge.style.background).toBe(colour(THEME_COLOR.purple));
  });

  it("a new colour of this profile still reaches its badges on the Profile page", async () => {
    let settings: ReturnType<typeof useSettings> | undefined;
    const Grab = () => { settings = useSettings(); return null; };
    page(<><Grab /><Profile /></>, "/profile");
    await screen.findByTestId("account-nickname");
    await settle();

    act(() => settings!.updateColorTheme("purple"));
    await settle();
    const badges = [...document.querySelectorAll<HTMLElement>("[data-testid=profile-page] [data-initial]")];
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].style.background).toBe(colour(THEME_COLOR.purple));
  });
});

describe("another profile's changes", () => {
  it("still reach the glances: added, renamed, its chats counted", async () => {
    const [work] = others();
    const { result } = renderHook(() => useProfileGlances());
    await waitFor(() => expect(result.current.othersUnread).toBe(15));

    act(() => renameProfile(work.id, "Office"));
    await waitFor(() => expect(result.current.others.map((o) => o.entry.name)).toContain("Office"));

    act(() => { const added = createProfile("Band"); localStorage.setItem(`${prefixOf(added.id)}c1`, JSON.stringify(chat("c1", 2))); });
    await waitFor(() => expect(result.current.others.map((o) => o.entry.name)).toContain("Band"));
    await waitFor(() => expect(result.current.othersUnread).toBe(17));
  });
});
