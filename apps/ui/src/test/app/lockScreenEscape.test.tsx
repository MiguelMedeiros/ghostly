import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { useDialogFocus } from "../../hooks/useDismiss";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";

// covers: settings.lock.idle

/** A dialog of the app's own (Send files, a new wallet, Add identity...): a plain modal that Escape closes. */
function Sheet() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  return open ? <SheetBox panel={ref} onClose={() => setOpen(false)} /> : null;
}

function SheetBox({ panel, onClose }: { panel: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  useDialogFocus(panel, onClose);
  return <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Send files"><input aria-label="Caption" defaultValue="for you" /></div>;
}

function Lock() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

const { showModal, close } = HTMLDialogElement.prototype;
const layerDepth = () => (history.state as Record<string, unknown> | null)?.ghostlyLayer;
const lockField = () => screen.getByLabelText("Ghostly is locked").querySelector("input[type=password]") as HTMLInputElement;

describe("Escape on the lock screen", () => {
  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
    const hash = await hashPassword("pw");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
    handOverUnlock(activeProfileId(), hash);
    renderApp(<LockScreenProvider><LockScreen /><Lock /><Sheet /></LockScreenProvider>);
  });
  afterEach(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    localStorage.clear(); sessionStorage.clear();
  });

  it("leaves the app's dialog under the lock open, as it was", async () => {
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(lockField()).toHaveFocus();
    fireEvent.keyDown(lockField(), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Send files", hidden: true })).toBeInTheDocument();

    fireEvent.change(lockField(), { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(lockField().closest("form")!); });
    await screen.findByText("false");
    expect(screen.getByRole("dialog", { name: "Send files" })).toBeInTheDocument();
    expect(screen.getByLabelText("Caption")).toHaveValue("for you");
  });

  it("Back (Android's back gesture) leaves the dialog under the lock open too, and the app on its page", async () => {
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    // The lock takes an entry of its own once it is in.
    await waitFor(() => expect(layerDepth()).toBe(2));
    await act(async () => { history.back(); });
    await waitFor(() => expect(layerDepth()).toBe(1));
    expect(screen.getByTestId("lock")).toHaveTextContent("true");
    expect(screen.getByRole("dialog", { name: "Send files", hidden: true })).toBeInTheDocument();
    // It takes an entry again: the next Back is the lock screen's too, never the page's.
    await waitFor(() => expect(layerDepth()).toBe(2));

    fireEvent.change(lockField(), { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(lockField().closest("form")!); });
    await screen.findByText("false");
    expect(screen.getByLabelText("Caption")).toHaveValue("for you");
  });

  it("is the dialog's own once the app is unlocked: it closes it", () => {
    fireEvent.keyDown(screen.getByLabelText("Caption"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Send files" })).not.toBeInTheDocument();
  });
});
