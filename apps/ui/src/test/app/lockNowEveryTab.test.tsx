import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.now

function Probe({ tab }: { tab: string }) {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid={`lock-${tab}`} onClick={lock}>{String(isLocked)}</button>;
}

/** A tab of the app (the extension opens several), unlocked: each takes the lock passed across its reload. */
function openTab(tab: string) {
  handOverUnlock(activeProfileId(), "x");
  renderApp(<LockScreenProvider><Probe tab={tab} /></LockScreenProvider>);
  expect(screen.getByTestId(`lock-${tab}`).textContent).toBe("false");
}

describe("Lock Now with the app open in two tabs", () => {
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("locks the other tab too", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    openTab("a");
    openTab("b");
    act(() => { fireEvent.click(screen.getByTestId("lock-a")); });
    expect(screen.getByTestId("lock-a").textContent).toBe("true");
    await waitFor(() => expect(screen.getByTestId("lock-b").textContent).toBe("true"));
  });
});
