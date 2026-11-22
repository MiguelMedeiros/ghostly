import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { registerFileBytes, resetFileBytes, type FileBytes } from "@ghostly/browser/shared/fileBytes";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";

// covers: settings.storage-used

/*
 * Opening Settings in the Desktop and Android apps reads "Storage used" once. The recounts a second and five seconds
 * later are for Delete all chats; the page's first count of its own settings is no deletion, so it reads the files
 * folder and the WebView's estimate again for nothing, and draws the whole page twice more after it opened.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("not here"); }), getVersion: async () => "1.11.2", getIdentifier: async () => "tools.ghostly.app", listen: async () => () => {} }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  resetFileBytes();
});

it("reads the storage once when Settings opens", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  localStorage.setItem("hunt-some-setting", "x".repeat(100));
  const usage = vi.fn(async () => ({ files: 6_000_000, count: 2, staged: 0 }));
  registerFileBytes("native", async () => ({ kind: "native", usage }) as unknown as FileBytes, true);
  renderApp(
    <LockScreenProvider>
      <UpdateProvider>
        <Routes><Route path="/settings" element={<Settings />} /></Routes>
      </UpdateProvider>
    </LockScreenProvider>,
    { route: "/settings" },
  );
  expect(await screen.findByTestId("settings-page")).toBeInTheDocument();
  await vi.waitFor(() => expect(usage).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  expect(usage).toHaveBeenCalledTimes(1);
});
