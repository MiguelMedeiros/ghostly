import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkSettings } from "../../components/NetworkSettings";
import { renderApp } from "../render";

// covers: settings.network.native-dht, settings.network.relays

const RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];

/** A row's longer explanation: behind its ⓘ, shown once asked for. */
async function info(user: { click: (el: Element) => Promise<void> }, row: HTMLElement): Promise<HTMLElement> {
  await user.click(within(row).getByTestId("row-info"));
  return within(row).getByTestId("row-info-text");
}

describe("Settings, Network: Pkarr relays", () => {
  it("on the Desktop, relay reads are off until switched on, at once, with the relays as saved", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Mainline DHT (BEP44) — Direct UDP", relays: [], direct: true }, settings: { relays: RELAYS } }));
    const toggle = screen.getByTestId("network-read-relays");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("network-read-relays-row")).toHaveTextContent("Relays see which keys it looks up");
    expect(await info(user, screen.getByTestId("network-read-relays-row"))).toHaveTextContent("reads the Mainline DHT directly");
    // An unsaved edit of the list does not go with the switch.
    await user.type(screen.getByTestId("network-relays"), "\nhttps://unsaved.example");
    await user.click(toggle);
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toEqual({ settings: { relays: RELAYS, iceServers: [], readRelays: true } });
    act(() => engine.update({ settings: { relays: RELAYS, readRelays: true } }));
    expect(screen.getByTestId("network-read-relays")).toHaveAttribute("aria-checked", "true");
    expect(await info(user, screen.getByTestId("network-relays-field"))).toHaveTextContent(/this app writes to them too/);
  });

  it("in a browser there is no switch: the relays are the only way to the DHT", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS }, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-read-relays")).toBeNull();
    expect(await info(user, screen.getByTestId("network-relays-field"))).toHaveTextContent(/Browsers cannot reach the Mainline DHT directly/);
  });
});
