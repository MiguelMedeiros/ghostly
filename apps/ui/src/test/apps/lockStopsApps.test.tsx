import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { appsRunning, registerRunningApp } from "../../lib/apps/open";
import { renderApp } from "../render";

// covers: apps.desktop-sandbox

function Probe() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

/** An app as an opener registers it: stopping it unregisters it, as its broker's `stopped` does. */
function run(ref: string) {
  const stop = vi.fn(() => unregister());
  const unregister = registerRunningApp({ ref, digest: "d", runAnyway: false, takeDown: () => {}, stop });
  return stop;
}

describe("an app running when the profile locks", () => {
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("stops: nothing of the profile answers it behind the lock", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    const chess = run("ana/chess");
    const snake = run("bob/snake");
    expect(screen.getByTestId("lock").textContent).toBe("false");
    expect(chess).not.toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(screen.getByTestId("lock").textContent).toBe("true");
    expect(chess).toHaveBeenCalledOnce();
    expect(snake).toHaveBeenCalledOnce();
    expect(appsRunning()).toBe(false);
  });
});
