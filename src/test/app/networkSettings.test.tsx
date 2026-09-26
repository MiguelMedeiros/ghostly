import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkSettings } from "../../components/NetworkSettings";
import { renderApp } from "../render";

// covers: settings.network.native-dht, settings.network.relays

const RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app", "https://relay.pkarr.org"];

describe("Settings, Network: Pkarr relays", () => {
  it("on the Desktop, relay reads are off until switched on, at once, with the relays as saved", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }, settings: { relays: RELAYS } }));
    const toggle = screen.getByTestId("network-read-relays");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("network-read-relays-row")).toHaveTextContent("reads the Mainline DHT directly");
    // An unsaved edit of the list does not go with the switch.
    await user.type(screen.getByTestId("network-relays"), "\nhttps://unsaved.example");
    await user.click(toggle);
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toEqual({ settings: { relays: RELAYS, iceServers: [], readRelays: true } });
    act(() => engine.update({ settings: { relays: RELAYS, readRelays: true } }));
    expect(screen.getByTestId("network-read-relays")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/this app writes to them too/)).toBeInTheDocument();
  });

  it("in a browser there is no switch: the relays are the only way to the DHT", () => {
    const { engine } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-read-relays")).toBeNull();
    expect(screen.getByText(/Browsers cannot reach the Mainline DHT directly/)).toBeInTheDocument();
  });
});
