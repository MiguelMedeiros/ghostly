import { act, fireEvent, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";

/*
 * Unlocked, the keyboard focus goes back where it was when the lock came on: the message being typed when the time ran
 * out. The lock screen's dialog leaves the page as it unlocks (it is not closed), so the browser's own return of the focus
 * never happened, and the focus was on the page (seen on the Linux Desktop).
 */

/** The right password is checked for real (PBKDF2, 600,000 rounds): more than findBy's 1 s on a busy runner. */
const UNLOCK_WAIT = { timeout: 10_000 };

let lockNow: () => void = () => {};

/** Locks as the time running out does: from no control, the focus where the person left it. */
function Locker() {
  const { isLocked, lock } = useLockScreen();
  useEffect(() => {
    lockNow = lock;
  }, [lock]);
  return <p data-testid="locked">{String(isLocked)}</p>;
}

/** Takes the focus as the app comes back unlocked, before the lock screen hears of it: a call window answered from it. */
function Taker({ on }: { on: boolean }) {
  const { isLocked } = useLockScreen();
  const ref = useRef<HTMLDivElement>(null);
  const was = useRef(isLocked);
  useEffect(() => {
    if (on && was.current && !isLocked) ref.current?.focus();
    was.current = isLocked;
  }, [isLocked, on]);
  return <div ref={ref} tabIndex={-1} data-testid="taker" />;
}

function App({ field = true, taker = false }: { field?: boolean; taker?: boolean }) {
  return (
    <LockScreenProvider>
      <Taker on={taker} />
      <LockScreen />
      <Locker />
      {field && <textarea aria-label="Message" defaultValue="see you at" />}
      <button>Send</button>
    </LockScreenProvider>
  );
}

const lockField = () => screen.getByLabelText("Ghostly is locked").querySelector("input[type=password]") as HTMLInputElement;

async function unlock(): Promise<void> {
  fireEvent.change(lockField(), { target: { value: "pw" } });
  await act(async () => { fireEvent.submit(lockField().closest("form")!); });
  await screen.findByText("false", undefined, UNLOCK_WAIT);
}

// covers: settings.lock.idle
describe("the focus after the unlock", () => {
  const { showModal, close } = HTMLDialogElement.prototype;

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
    const hash = await hashPassword("pw");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 1 } }));
    handOverUnlock(activeProfileId(), hash);
  });
  afterEach(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    localStorage.clear(); sessionStorage.clear();
  });

  it("goes back to the message field it was in when the lock came on", async () => {
    renderApp(<App />);
    const message = screen.getByLabelText("Message");
    message.focus();
    act(() => lockNow());
    expect(lockField()).toHaveFocus();

    await unlock();
    expect(message).toHaveFocus();
  });

  it("stays where something else put it as the app came back (a call answered from the lock screen)", async () => {
    renderApp(<App taker />);
    screen.getByLabelText("Message").focus();
    act(() => lockNow());

    await unlock();
    expect(screen.getByTestId("taker")).toHaveFocus();
  });

  it("is left alone when the control it was on is gone (Lock Now, which leaves Settings for home)", async () => {
    const { rerender } = renderApp(<App />);
    screen.getByLabelText("Message").focus();
    act(() => lockNow());
    rerender(<App field={false} />);

    await unlock();
    expect(document.activeElement).toBe(document.body);
  });
});
