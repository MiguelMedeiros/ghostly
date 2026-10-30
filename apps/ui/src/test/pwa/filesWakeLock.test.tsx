import { act, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileTransferView } from "@ghostly/browser/shared/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.keep-awake

/*
 * A file on its way keeps the screen on (Screen Wake Lock, where there is one), as a call does: a phone that dims and
 * sleeps stops the transfer. One waiting for the contact to come online does not.
 */

vi.mock("../../pages/Chat", () => ({ Chat: () => null }));
vi.mock("../../components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
// Desktop's menu and shortcuts need the lock screen's provider, which is not what this is about.
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

const { App } = await import("../../App");

const moving: FileTransferView = { state: "transferring", transferred: 10, size: 100, direction: "in", rate: 5 };

afterEach(() => { Reflect.deleteProperty(navigator, "wakeLock"); });

describe("the screen stays on while a file is on its way", () => {
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
