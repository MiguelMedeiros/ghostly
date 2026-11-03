import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";

// covers: settings.lock.idle

/*
 * happy-dom has no top layer: showModal() and close() stand in, recording which dialog went last into it (the one drawn
 * over the others, the only one that takes the focus and the keys) and firing `close` as the browser does.
 */
const { showModal, close } = HTMLDialogElement.prototype;
let shown: HTMLDialogElement[] = [];
const top = () => shown.filter((dialog) => dialog.open).pop();

function Chat() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

/** The app open and unlocked with "pw", a dialog of its own open as modal over the chat, portalled to the body. */
async function openWithDialog() {
  const hash = await hashPassword("pw");
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), hash);
  renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
  const dialog = document.createElement("dialog");
  dialog.innerHTML = "<input data-testid='other-field'>";
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

const LOCKED = "Ghostly is locked";
const lockScreen = () => screen.getByLabelText(LOCKED) as HTMLDialogElement;

describe("the lock screen goes over every layer of the app, and only the password reaches through", () => {
  beforeEach(() => {
    shown = [];
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      shown = [...shown.filter((dialog) => dialog !== this), this];
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  });
  afterEach(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
    document.querySelectorAll("body > dialog").forEach((dialog) => dialog.remove());
    localStorage.clear(); sessionStorage.clear();
  });

  it("locking over an open dialog puts the lock screen last in the top layer, its password field focused", async () => {
    const other = await openWithDialog();
    expect(top()).toBe(other);
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(lockScreen().tagName).toBe("DIALOG");
    expect(top()).toBe(lockScreen());
    expect(document.activeElement).toBe(lockScreen().querySelector("input[type=password]"));
  });

  it("Escape does not close it, and a close the page can't refuse shows it again at once", async () => {
    await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const escape = new Event("cancel", { cancelable: true });
    act(() => { lockScreen().dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    act(() => { lockScreen().close(); });
    expect(lockScreen().open).toBe(true);
    expect(top()).toBe(lockScreen());
  });

  it("a dialog or popover opened while locked goes under it", async () => {
    await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const late = document.createElement("dialog");
    document.body.append(late);
    await act(async () => { late.showModal(); late.setAttribute("open", ""); await Promise.resolve(); });
    expect(top()).toBe(lockScreen());
    const list = document.createElement("div");
    document.body.append(list);
    shown = shown.filter((dialog) => dialog !== lockScreen()).concat(late);
    act(() => { list.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" })); });
    expect(top()).toBe(lockScreen());
  });

  it("the right password takes it away, and the dialog under it is as it was", async () => {
    const other = await openWithDialog();
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    const field = lockScreen().querySelector("input[type=password]")!;
    fireEvent.change(field, { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    await screen.findByText("false");
    expect(screen.queryByLabelText(LOCKED)).not.toBeInTheDocument();
    expect(top()).toBe(other);
  });
});
