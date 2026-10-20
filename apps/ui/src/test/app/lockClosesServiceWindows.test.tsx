import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { setServiceWindowsCloser } from "../../lib/serviceWindows";
import { renderApp } from "../render";

// covers: services.desktop-viewer

function Probe() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

describe("a contact's app window open when the profile locks", () => {
  afterEach(() => { setServiceWindowsCloser(null); localStorage.clear(); sessionStorage.clear(); });

  it("closes: the page does not go on serving it behind the lock", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), "x");
    const close = vi.fn();
    setServiceWindowsCloser(close);
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(screen.getByTestId("lock").textContent).toBe("false");
    expect(close).not.toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(screen.getByTestId("lock").textContent).toBe("true");
    expect(close).toHaveBeenCalledOnce();
  });
});
