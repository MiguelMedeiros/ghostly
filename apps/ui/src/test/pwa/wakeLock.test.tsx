import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWakeLock } from "../../hooks/useWakeLock";
import { Route, Routes } from "react-router-dom";
import type { FileTransferView } from "@ghostly/browser/shared/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../pages/Chat", () => ({ Chat: () => null }));
vi.mock("../../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
// Desktop's menu and shortcuts need the lock screen's provider, which is not what this is about.
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));
const { App } = await import("../../App");

// covers: calls.wake-lock
describe("the screen stays on during a call", () => {
  let sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[] = [];
  const request = vi.fn(async () => {
    const sentinel = { released: false, release: vi.fn(async () => { sentinel.released = true; }) };
    sentinels.push(sentinel);
    return sentinel;
  });
  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    sentinels = [];
    request.mockClear();
    visibility = "visible";
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "wakeLock");
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("asks while on a call, again when the page comes back, and lets go after", async () => {
    const { rerender, unmount } = renderHook(({ active }) => useWakeLock(active), { initialProps: { active: false } });
    expect(request).not.toHaveBeenCalled();
    rerender({ active: true });
    await act(async () => {});
    expect(request).toHaveBeenCalledWith("screen");

    // Hidden: the system lets go of it; back: asked again.
    sentinels[0]!.released = true;
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(2);

    rerender({ active: false });
    expect(sentinels[1]!.release).toHaveBeenCalled();
    unmount();
  });

  it("does nothing where there is no Wake Lock", () => {
    Reflect.deleteProperty(navigator, "wakeLock");
    expect(() => renderHook(() => useWakeLock(true)).unmount()).not.toThrow();
  });
});

// covers: files.keep-awake
describe("the screen stays on while a file is on its way", () => {
  /*
   * A file on its way keeps the screen on (Screen Wake Lock, where there is one), as a call does: a phone that dims and
   * sleeps stops the transfer. One waiting for the contact to come online does not.
   */

  const moving: FileTransferView = { state: "transferring", transferred: 10, size: 100, direction: "in", rate: 5 };

  afterEach(() => { Reflect.deleteProperty(navigator, "wakeLock"); });

  it("asks once a file moves, not while it waits for the contact, and lets go when it ends", async () => {
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ released: false, release }));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    fakeEngine.update({ transfers: { "l-in-1": { ...moving, stage: "waiting" } } });
    renderApp(<Routes><Route path="/*" element={<App />} /></Routes>, { route: "/" });
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
    act(() => fakeEngine.update({ transfers: { "l-in-1": moving } }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    act(() => fakeEngine.update({ transfers: { "l-in-1": { ...moving, state: "failed", error: "Cancelled" } } }));
    await waitFor(() => expect(release).toHaveBeenCalled());
    expect(request).toHaveBeenCalledTimes(1);
  });
});
