import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { useSettings } from "../../contexts/SettingsContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.idle

/** Turns the lock off and on again, as Settings > Privacy does. */
function Switch() {
  const { updateLockScreen } = useSettings();
  return (
    <>
      <button data-testid="off" onClick={() => updateLockScreen({ enabled: false })} />
      <button data-testid="on" onClick={() => updateLockScreen({ enabled: true })} />
    </>
  );
}

function open(lockOn: boolean, passwordHash = "x") {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: lockOn, passwordHash, timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), passwordHash);
  renderApp(<LockScreenProvider><Switch /></LockScreenProvider>);
}

describe("with the lock on, the system's app switcher keeps no picture of the app (Android)", () => {
  let hide: ReturnType<typeof vi.fn<(on: boolean) => Promise<void>>>;
  beforeEach(() => {
    hide = vi.fn(async (_on: boolean) => {});
    setBrowserHost({ hideFromSwitcher: hide } as Partial<BrowserHost> as BrowserHost);
  });
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("tells the host as the app opens with the lock on, and again as the lock goes off and on", () => {
    open(true);
    expect(hide).toHaveBeenLastCalledWith(true);
    act(() => screen.getByTestId("off").click());
    expect(hide).toHaveBeenLastCalledWith(false);
    act(() => screen.getByTestId("on").click());
    expect(hide).toHaveBeenLastCalledWith(true);
  });

  it("with no lock set, asks for nothing to be hidden", () => {
    open(false);
    expect(hide).not.toHaveBeenCalledWith(true);
  });

  it("a lock turned on with no password hides nothing", () => {
    open(true, "");
    expect(hide).not.toHaveBeenCalledWith(true);
  });
});
