import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { useSettings } from "../../contexts/SettingsContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.now

const KEY = "ghostly_app_settings";

/** A tab of the app (the extension opens several): Lock Now, a password set here, and the sounds switch. */
function Tab({ tab }: { tab: string }) {
  const { isLocked, lock } = useLockScreen();
  const { settings, updateLockScreen, updateNotifications } = useSettings();
  return (
    <>
      <button data-testid={`lock-${tab}`} data-hash={settings.lockScreen.passwordHash ?? ""} onClick={lock}>{String(isLocked)}</button>
      <button data-testid={`password-${tab}`} onClick={() => updateLockScreen({ enabled: true, passwordHash: "new" })} />
      <button data-testid={`sounds-${tab}`} onClick={() => updateNotifications({ soundEnabled: !settings.notifications.soundEnabled })} />
    </>
  );
}

function openTab(tab: string) {
  handOverUnlock(activeProfileId(), stored().lockScreen?.passwordHash);
  renderApp(<LockScreenProvider><Tab tab={tab} /></LockScreenProvider>);
  expect(screen.getByTestId(`lock-${tab}`).textContent).toBe("false");
}

const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as { lockScreen?: { enabled?: boolean; passwordHash?: string | null }; notifications?: { soundEnabled?: boolean } };
const click = (id: string) => act(() => { fireEvent.click(screen.getByTestId(id)); });
/** What the browser tells the other tabs when one saves the settings. */
const otherTabSaved = () => act(() => { window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: localStorage.getItem(KEY) })); });

describe("the lock with the app open in two tabs", () => {
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("a password set in one tab: Lock Now there locks the tab opened before it", async () => {
    openTab("a");
    openTab("b");
    click("password-a");
    expect(stored().lockScreen?.passwordHash).toBe("new");
    click("lock-a");
    expect(screen.getByTestId("lock-a").textContent).toBe("true");
    await waitFor(() => expect(screen.getByTestId("lock-b").textContent).toBe("true"));
  });

  it("a setting saved in the tab opened before keeps the password set in the other", () => {
    openTab("a");
    openTab("b");
    click("password-a");
    click("sounds-b");
    expect(stored().notifications?.soundEnabled).toBe(false);
    expect(stored().lockScreen).toMatchObject({ enabled: true, passwordHash: "new" });
  });

  it("a password changed in another tab is not brought back by a setting saved in this one", () => {
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "old", timeoutMinutes: 5 } }));
    openTab("b");
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "changed", timeoutMinutes: 5 } }));
    click("sounds-b");
    expect(stored().lockScreen?.passwordHash).toBe("changed");
  });

  it("takes a password set in another tab as it lands", () => {
    openTab("b");
    localStorage.setItem(KEY, JSON.stringify({ lockScreen: { enabled: true, passwordHash: "new", timeoutMinutes: 5 } }));
    otherTabSaved();
    expect(screen.getByTestId("lock-b").dataset.hash).toBe("new");
  });
});
