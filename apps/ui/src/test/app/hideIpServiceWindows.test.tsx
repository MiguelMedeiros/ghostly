import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setServiceWindowsCloser } from "../../lib/serviceWindows";
import { renderApp } from "../render";

// covers: settings.network.relay-only

/**
 * A contact's app opened with "Hide my IP from contacts" off loads from wherever it says (Desktop, web) or may send its
 * tab to any server (the extension): turning the setting on closes it, as the lock does.
 */
describe("Hide my IP from contacts, and a contact's app open", () => {
  afterEach(() => setServiceWindowsCloser(null));

  it("closes every contact's app window when it turns on, and only then", () => {
    const close = vi.fn();
    setServiceWindowsCloser(close);
    const { engine } = renderApp(<LockScreenProvider><UpdateProvider><App /></UpdateProvider></LockScreenProvider>, { route: "/settings/network" });
    act(() => engine.update({ settings: { ...engine.state.settings, relayOnly: undefined } }));
    expect(close).not.toHaveBeenCalled();

    act(() => engine.update({ settings: { ...engine.state.settings, relayOnly: true } }));
    expect(close).toHaveBeenCalledTimes(1);
    // Another state with it still on, or turned off: nothing more to close.
    act(() => engine.update({ settings: { ...engine.state.settings, relays: ["https://relay.example.org"] } }));
    act(() => engine.update({ settings: { ...engine.state.settings, relayOnly: undefined } }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
