import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { searchSettings } from "../../lib/settingsSections";
import { useGroupDownloadsSync } from "../../lib/groupDownloads";
import { Settings } from "../../pages/Settings";
import en from "../../locales/en";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: settings.group-downloads

/** A browser that says what its connection is (Chrome on Android), on `type` until a test changes it. */
function connectionOf(type: string) {
  const connection = Object.assign(new EventTarget(), { type });
  Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
  return {
    to(next: string) { connection.type = next; act(() => { connection.dispatchEvent(new Event("change")); }); },
  };
}

function Synced() {
  useGroupDownloadsSync();
  return <Settings />;
}

const open = () => renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Synced />} /></Routes></UpdateProvider></LockScreenProvider>,
  { route: "/settings/storage" });
const choice = () => screen.getByTestId("settings-group-downloads");
const last = () => { const calls = fakeEngine.callsTo("updateSettings"); return calls[calls.length - 1]; };

beforeEach(() => {
  windowIs(false);
  fakeEngine.on("updateSettings", ({ settings }) => { fakeEngine.update({ settings: { ...fakeEngine.state.settings, autoDownloads: settings.autoDownloads } }); });
});
afterEach(() => { delete (navigator as { connection?: unknown }).connection; });

describe("Download automatically in groups", () => {
  it("sits in Data & storage, on by default as the engine keeps it, and Off reaches the engine", async () => {
    const { user } = open();
    expect(screen.getByTestId("settings-group-downloads-row")).toHaveTextContent("Download automatically in groups");
    expect(choice()).toHaveTextContent("Always");
    // No Wi-Fi only where the browser cannot tell (a desktop browser).
    await user.click(choice());
    expect(screen.queryByRole("option", { name: "Wi-Fi only" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Off" }));
    expect(fakeEngine.callsTo("updateSettings")).toEqual([{ settings: { autoDownloads: false } }]);
    expect(choice()).toHaveTextContent("Off");
    await user.click(choice());
    await user.click(screen.getByRole("option", { name: "Always" }));
    expect(fakeEngine.callsTo("updateSettings")).toEqual([{ settings: { autoDownloads: false } }, { settings: { autoDownloads: true } }]);
  });

  it("shows Off when the engine has them off (set from the CLI, or another page)", () => {
    fakeEngine.update({ settings: { ...fakeEngine.state.settings, autoDownloads: false } });
    open();
    expect(choice()).toHaveTextContent("Off");
  });

  it("Wi-Fi only, where the browser says: on with Wi-Fi, off on mobile data, following the connection", async () => {
    const network = connectionOf("cellular");
    const { user } = open();
    await user.click(choice());
    await user.click(screen.getByRole("option", { name: "Wi-Fi only" }));
    expect(choice()).toHaveTextContent("Wi-Fi only");
    expect(fakeEngine.callsTo("updateSettings")[0]).toEqual({ settings: { autoDownloads: false } });
    network.to("wifi");
    await vi.waitFor(() => expect(last()).toEqual({ settings: { autoDownloads: true } }));
    network.to("cellular");
    await vi.waitFor(() => expect(last()).toEqual({ settings: { autoDownloads: false } }));
    // Kept on this device: the choice is still Wi-Fi only, whatever the engine's switch says now.
    expect(choice()).toHaveTextContent("Wi-Fi only");
  });

  it("is found by the settings search", () => {
    const found = searchSettings("automatic", translateWith(en), () => true).map(entry => entry.label);
    expect(found).toContain("settings.groupDownloads.title");
  });
});
