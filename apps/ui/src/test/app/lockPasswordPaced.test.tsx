import { act, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { assertUnlocked, deleteProfile } from "../../lib/profileData";
import { createProfileBackup } from "../../lib/profileBackup";
import { namespaceOf, setRunningProfile, settingsKeyFor } from "../../lib/profiles";
import { setStorageProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: profiles.lock, profiles.delete

/** Another profile of this space, with a lock. */
const OTHER = "abcdefghij";
const RIGHT = "the right one";

/** The oldest stored form of a lock password (unsalted SHA-256): quick to check here, and still accepted. */
async function quickHash(password: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function lockWith(id: string, password: string) {
  localStorage.setItem(settingsKeyFor(id), JSON.stringify({ lockScreen: { enabled: true, passwordHash: await quickHash(password), timeoutMinutes: 5 } }));
}

/** This page as profile `id` (the default profile: ""). */
function runAs(id: string) {
  setRunningProfile(id || undefined);
  setStorageProfile(namespaceOf(id));
}

const seen: { lock?: ReturnType<typeof useLockScreen> } = {};
function Probe() {
  const lock = useLockScreen();
  useEffect(() => { seen.lock = lock; });
  return null;
}
const lockScreen = { unlock: (password: string) => seen.lock!.unlock(password), get retryAt() { return seen.lock!.retryAt; } };
function openLockScreen() {
  return renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
}

const tries = { delete: (password: string) => deleteProfile(OTHER, password), backup: (password: string) => createProfileBackup("a long backup passphrase", OTHER, password) };

describe("every check of a profile's lock password is paced, per profile", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    runAs("");
    await lockWith(OTHER, RIGHT);
  });
  afterEach(() => { vi.useRealTimers(); runAs(""); localStorage.clear(); });

  it.each(Object.keys(tries) as (keyof typeof tries)[])("another profile's %s: after three wrong passwords even the right one waits", async (way) => {
    for (let i = 0; i < 3; i++) await expect(tries[way](`wrong ${i}`)).rejects.toThrow("Wrong lock password for that profile");
    await expect(tries[way](RIGHT)).rejects.toThrow("Too many attempts. Try again in 1 s");
    await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(/Too many attempts/);
    vi.setSystemTime(Date.now() + 1_000);
    await expect(assertUnlocked(OTHER, RIGHT)).resolves.toBeUndefined();
  });

  it("the wait doubles with each wrong password, up to five minutes", async () => {
    for (let i = 0; i < 3; i++) await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow();
    for (const seconds of [2, 4, 8, 16, 32, 64, 128, 256, 300, 300]) {
      vi.setSystemTime(Date.now() + 300_000);
      await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow("Wrong lock password for that profile");
      await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(`Too many attempts. Try again in ${seconds} s`);
    }
  });

  it("the Delete dialog shows the wait and holds Delete and Save until it is over", async () => {
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: OTHER, name: "Work", createdAt: 0 }} onClose={() => {}} />);
    await user.type(screen.getByTestId("delete-profile-confirm"), "Work");
    const password = screen.getByTestId("delete-profile-password");
    for (let i = 0; i < 3; i++) {
      await user.clear(password);
      await user.type(password, `wrong ${i}`);
      await user.click(screen.getByTestId("delete-profile-go"));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Try again in 1 s");
    // Pressed, it keeps the focus through the wait: off by aria-disabled.
    expect(screen.getByTestId("delete-profile-go")).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("one profile's right password leaves another's wait as it was", async () => {
    await lockWith("", "mine");
    for (let i = 0; i < 3; i++) await expect(assertUnlocked(OTHER, "wrong")).rejects.toThrow();
    const view = openLockScreen();
    await act(async () => { expect(await lockScreen.unlock("mine")).toBe(true); });
    view.unmount();
    await expect(assertUnlocked(OTHER, RIGHT)).rejects.toThrow(/Too many attempts/);
  });

  it("the lock screen's wait is the profile's own: another profile's right password does not clear it", async () => {
    await lockWith("", "mine");
    runAs(OTHER);
    let view = openLockScreen();
    for (let i = 0; i < 3; i++) await act(async () => { expect(await lockScreen.unlock("wrong")).toBe(false); });
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    view.unmount();

    runAs("");
    view = openLockScreen();
    expect(lockScreen.retryAt).toBeNull();
    await act(async () => { expect(await lockScreen.unlock("mine")).toBe(true); });
    view.unmount();

    runAs(OTHER);
    openLockScreen();
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    await act(async () => { expect(await lockScreen.unlock(RIGHT)).toBe(false); });
  });

  it("a wait kept before profiles had their own is the first profile's", async () => {
    localStorage.setItem("ghostly_lock_attempts", JSON.stringify({ failures: 3, retryAt: Date.now() + 1_000 }));
    await lockWith("", "mine");
    const view = openLockScreen();
    expect(lockScreen.retryAt).toBeGreaterThan(Date.now());
    view.unmount();
    runAs(OTHER);
    openLockScreen();
    expect(lockScreen.retryAt).toBeNull();
  });
});
