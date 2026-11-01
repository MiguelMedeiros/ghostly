import { act, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceGateView } from "@ghostly/browser/devices/gate";
import { DeviceStandby } from "../../components/DeviceStandby";
import { TakeoverDialog } from "../../components/devices/TakeoverDialog";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";
// covers: devices.takeover, devices.gate

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/*
 * The lock the person passed in this tab, across the reloads a replaced device and a takeover make (WISP 06 § User
 * experience). What decides is the marker the next page would take: it must exist only while the lock stands passed.
 */

const HANDOVER = "ghostly_unlock_handover";
const HASH = "a-stored-password-hash";
const REPLACED: DeviceGateView = { state: "superseded", activeDevice: "Phone", reload: true, keepUnlocked: true };

let reload: ReturnType<typeof vi.fn>;
let lock: () => void;
let setGate: (gate: DeviceGateView) => void;

function Controls() {
  const { lock: close } = useLockScreen();
  useEffect(() => { lock = close; }, [close]);
  return null;
}

function Standby() {
  const [gate, set] = useState<DeviceGateView>({ state: "standby" });
  useEffect(() => { setGate = set; }, []);
  return <DeviceStandby gate={gate} />;
}

/** A page whose lock is open; what opening it left behind is gone, so a marker seen later is the page's own. */
function unlockedPage(children: ReactNode) {
  handOverUnlock(activeProfileId(), HASH);
  const view = renderApp(<LockScreenProvider><Controls />{children}</LockScreenProvider>);
  sessionStorage.removeItem(HANDOVER);
  return view;
}

const marker = () => JSON.parse(sessionStorage.getItem(HANDOVER) ?? "null") as { profile: string; hash: string } | null;

beforeEach(() => {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: HASH, timeoutMinutes: 5 } }));
  reload = vi.fn();
  vi.spyOn(window.location, "reload").mockImplementation(reload as unknown as () => void);
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.removeItem(HANDOVER); });

describe("a device that reads at start that it was replaced", () => {
  it("carries the lock just passed across its reload", async () => {
    unlockedPage(<Standby />);
    act(() => setGate(REPLACED));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toMatchObject({ profile: activeProfileId(), hash: HASH });
  });

  it("a page whose lock closed again carries nothing: a reload never opens a lock", async () => {
    unlockedPage(<Standby />);
    act(() => lock());
    act(() => setGate(REPLACED));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toBeNull();
  });

  it("a page past its time away carries nothing, even with no timer having locked it yet", async () => {
    unlockedPage(<Standby />);
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ["Date"] });
    act(() => setGate(REPLACED));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toBeNull();
  });

  it("a handoff's reload carries nothing: the device giving the profile away is often unattended", async () => {
    unlockedPage(<Standby />);
    act(() => setGate({ state: "releasing", reload: true }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toBeNull();
  });
});

describe("a forced takeover", () => {
  const dialog = <TakeoverDialog password={false} restored onClose={() => {}} />;

  it("carries the lock across the reload into the profile", async () => {
    const { user, engine } = unlockedPage(dialog);
    engine.on("deviceTakeover", () => ({ kind: "start" }));
    await user.click(screen.getByTestId("takeover-go"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toMatchObject({ profile: activeProfileId(), hash: HASH });
  });

  it("carries nothing when the lock closed during the half minute of its check", async () => {
    const { user, engine } = unlockedPage(dialog);
    engine.on("deviceTakeover", () => { act(() => lock()); return { kind: "start" }; });
    await user.click(screen.getByTestId("takeover-go"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(marker()).toBeNull();
  });
});
