import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NetworkSettings } from "../../components/NetworkSettings";
import { renderApp } from "../render";

// covers: settings.network.native-dht, settings.network.relays, settings.network.iroh-relays, settings.network.turn

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
    // The switch leaves the TURN server as it is: one restored without its credential does not stop it.
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toEqual({ settings: { relays: RELAYS, readRelays: true } });
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

describe("Settings, Network: Iroh relays", () => {
  const DEFAULTS = ["https://use1-1.relay.n0.iroh.link/", "https://euc1-1.relay.n0.iroh.link/"];
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS, iroh: { relays: DEFAULTS, defaults: DEFAULTS } };

  it("takes the defaults written with the trailing dot for the defaults, and keeps a relay of the person's own as typed", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    const field = screen.getByTestId("network-iroh-relays");
    // As Iroh itself names them, with the trailing dot: the same relays, stored as "none chosen".
    await user.clear(field);
    await user.type(field, DEFAULTS.map(url => url.replace("link/", "link./")).join("\n"));
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { irohRelays: [] } });
    await user.clear(field);
    await user.type(field, "https://relay.example.com/");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { irohRelays: ["https://relay.example.com/"] } });
  });
});

describe("Settings, Network: TURN server", () => {
  const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };

  it("says what is missing before saving, and saves the address, username and credential together", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    await user.type(screen.getByLabelText("TURN server URL"), "turn:turn.example.org:3478");
    await user.type(screen.getByLabelText("TURN username"), "ghost");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error")).toHaveTextContent("needs its username and credential");
    expect(engine.callsTo("updateSettings")).toEqual([]);

    expect(screen.getByLabelText("TURN credential")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("TURN credential"), "test-credential");
    await user.click(screen.getByTestId("network-save"));
    expect(engine.callsTo("updateSettings").slice(-1)[0]).toMatchObject({ settings: { iceServers: [{ urls: "turn:turn.example.org:3478", username: "ghost", credential: "test-credential" }] } });
    expect(screen.queryByTestId("network-error")).toBeNull();
  });

  it("refuses an address that is not TURN or STUN", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS } }));
    await user.type(screen.getByLabelText("TURN server URL"), "https://turn.example.org");
    await user.click(screen.getByTestId("network-save"));
    expect(screen.getByTestId("network-error")).toHaveTextContent("is not a TURN or STUN address");
    expect(engine.callsTo("updateSettings")).toEqual([]);
  });

  it("a server restored from a backup asks for its credential again", async () => {
    const { engine, user } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport, settings: { relays: RELAYS, iceServers: [{ urls: "turn:turn.example.org:3478", username: "ghost" }] } }));
    const field = screen.getByTestId("network-turn-field");
    expect(field).toHaveTextContent("Enter the credential again: backups leave it out.");
    expect(screen.getByLabelText("TURN server URL")).toHaveValue("turn:turn.example.org:3478");
    await user.type(screen.getByLabelText("TURN credential"), "x");
    expect(field).not.toHaveTextContent("Enter the credential again");
    expect(field).toHaveTextContent("Used only when a direct connection fails.");
  });
});
