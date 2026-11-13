import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { resetAppBadge, setAppBadgeTarget, useAppBadge } from "../../lib/appBadge";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { getPrefix, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.attention.badge

const message = (id: string) => ({ id, text: id, sender: "peer", timestamp: Date.now() - 1000 }) as ChatMessage;
const session = (id: string, messages: number): ChatSession =>
  ({ id, mySeedB64: "s", peerPubKeyB64: `peer-${id}`, encKeyB64: "e", createdAt: 0, messages: Array.from({ length: messages }, (_, i) => message(`${id}-${i}`)) }) as ChatSession;

/** The app's shell as far as the icon goes: it stays mounted under the lock. */
function Shell() {
  useAppBadge();
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

const lockField = () => screen.getByLabelText("Ghostly is locked").querySelector("input[type=password]") as HTMLInputElement;

describe("the number on the app's icon while the app is locked", () => {
  const icon: number[] = [];
  beforeEach(async () => {
    icon.length = 0;
    resetAppBadge();
    setAppBadgeTarget({ setAppBadge: async (count) => { icon.push(count ?? 0); }, clearAppBadge: async () => { icon.push(0); } });
    saveSession(session("a", 2));
    const hash = await hashPassword("pw");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), hash);
    renderApp(<LockScreenProvider><LockScreen /><Shell /></LockScreenProvider>);
  });
  afterEach(() => {
    setAppBadgeTarget(null);
    resetAppBadge();
    localStorage.clear(); sessionStorage.clear();
  });

  it("is cleared when the app locks, says nothing of what comes while locked, and comes back on unlock", async () => {
    expect(screen.getByTestId("lock")).toHaveTextContent("false");
    expect(icon).toEqual([2]);

    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(icon).toEqual([2, 0]);

    // Messages arrive under the lock.
    saveSession(session("a", 7));
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key: `${getPrefix()}a` })); });
    expect(icon).toEqual([2, 0]);

    fireEvent.change(lockField(), { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(lockField().closest("form")!); });
    await screen.findByText("false");
    // The number comes from useAppBadge's effect, which React may run a task after the page shows the unlock: findBy
    // resolves on the page, outside act, so it is waited for.
    await waitFor(() => expect(icon).toEqual([2, 0, 7]));
  });
});
