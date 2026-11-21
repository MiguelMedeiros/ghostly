import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { RECOUNT_AFTER_MS } from "../../lib/desktopStorage";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: settings.storage-used

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined), listen: async () => () => {}, getVersion: async () => "0.4.0" }));

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  resetFileBytes();
  vi.useRealTimers();
});

it("Settings on the Desktop counts the profile's files once when it opens, not again a second and five seconds later", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("ghostly_some_setting", "x".repeat(500));
  const usage = vi.fn(async () => ({ files: 10, count: 1, staged: 0 }));
  registerFileBytes("native", async () => ({ kind: "native", usage }) as unknown as FileBytes, true);
  renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings/storage" },
  );
  await screen.findByTestId("settings-storage-used");
  await act(() => vi.advanceTimersByTimeAsync(Math.max(...RECOUNT_AFTER_MS) + 100));
  expect(usage).toHaveBeenCalledTimes(1);
});
