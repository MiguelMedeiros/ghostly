import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { renderApp } from "../render";

// covers: settings.lock.idle

const HOUR = 3_600_000;

function Chat() {
  const { isLocked } = useLockScreen();
  return <p data-testid="locked">{String(isLocked)}</p>;
}

/** The app open and unlocked on a chat; "lock after 5 minutes" on unless `lockOn` is false. */
function open(lockOn = true) {
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: lockOn, passwordHash: "x", timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), "x");
  renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
  expect(screen.getByTestId("locked")).toHaveTextContent("false");
}

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};
const cover = () => screen.queryByTestId("lock-cover");

describe("with the lock on, the app switcher's picture of the app shows no content", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

  it("covers the app as it goes hidden, and back sooner than the time shows the chat again", () => {
    open();
    expect(cover()).not.toBeInTheDocument();
    setVisibility("hidden");
    expect(cover()).toBeInTheDocument();
    vi.setSystemTime(Date.now() + 60_000);
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByTestId("locked")).toHaveTextContent("false");
  });

  it("back after the time, the cover gives way to the lock screen, never to the chat", () => {
    open();
    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 8 * HOUR);
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("covers on pagehide too", () => {
    open();
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(cover()).toBeInTheDocument();
  });

  it("on a phone, covers when the app loses the focus, not when a frame of the page takes it", () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    open();
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(cover()).toBeInTheDocument();
    focused.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(cover()).not.toBeInTheDocument();

    const frame = document.createElement("iframe");
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    focused.mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(cover()).not.toBeInTheDocument();
  });

  it("the cover goes over every layer the page draws: last in the top layer, and again over one opened while away", async () => {
    // happy-dom has no top layer: the popover API stands in, recording what was raised.
    const raised: Element[] = [];
    Object.assign(HTMLElement.prototype, { showPopover(this: HTMLElement) { raised.push(this); }, hidePopover() {} });
    const dialog = document.createElement("dialog"), list = document.createElement("div");
    try {
      open();
      setVisibility("hidden");
      expect(raised).toEqual([cover()]);
      // A dialog opened modal, then a popover (a select's list), while away: the cover goes over each.
      document.body.append(dialog, list);
      await act(async () => { dialog.setAttribute("open", ""); await vi.advanceTimersByTimeAsync(0); });
      expect(raised).toEqual([cover(), cover()]);
      act(() => { list.dispatchEvent(new Event("toggle")); });
      expect(raised).toEqual([cover(), cover(), cover()]);
      // Its own toggle does not raise it again.
      act(() => { cover()!.dispatchEvent(new Event("toggle")); });
      expect(raised).toHaveLength(3);
    } finally {
      dialog.remove(); list.remove();
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
      delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    }
  });

  it("away while locked, the cover goes over the lock screen too: a layer left open under it stays out of the picture", () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    // A page started without a handover: past the moment an earlier test's page took its own.
    vi.setSystemTime(Date.now() + 10_000);
    renderApp(<LockScreenProvider><LockScreen /><Chat /></LockScreenProvider>);
    expect(screen.getByTestId("locked")).toHaveTextContent("true");
    expect(cover()).not.toBeInTheDocument();
    setVisibility("hidden");
    expect(cover()).toBeInTheDocument();
    setVisibility("visible");
    expect(cover()).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("with the lock off, covers nothing", () => {
    open(false);
    setVisibility("hidden");
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(cover()).not.toBeInTheDocument();
  });
});
