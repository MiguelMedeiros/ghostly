import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { NetworkSettings } from "../../components/NetworkSettings";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.direct-blocked

type Pairing = NonNullable<LinkView["pairing"]>;
const RELAYS = ["https://pkarr.pubky.org"];
const web = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };
const relayed = linkView({ availableTransports: ["webrtc/1", "iroh/1"], peerTransports: ["webrtc/1", "iroh/1"], relayedTransports: ["iroh/1"], transportAutomatic: true,
  pairing: { status: "ready", transport: "iroh/1" } as Pairing, dataLink: "open", transportRelayed: { relays: ["relay.example"] } });
const HINT = "Direct connections are blocked on this network (a VPN or firewall?). Chats still work through relays, but connect more slowly.";

describe("the note that direct connections are blocked on this network", () => {
  it("is in the chat's connection panel while the engine says so, one short line with the story behind its ⓘ", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: { ...web, directBlocked: true }, links: [relayed] }));
    await view.user.click(screen.getByTestId("connection-options"));
    const panel = screen.getByRole("dialog", { name: "Connection options" });
    const note = within(panel).getByTestId("connection-direct-blocked");
    expect(note).toHaveTextContent(HINT);
    // It never says a VPN was found, and it is no alarm: the chat works.
    expect(note).not.toHaveTextContent(/VPN detected/i);
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(within(note).queryByTestId("connection-direct-blocked-text")).toBeNull();
    const more = within(note).getByRole("button", { name: "More info" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await view.user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const story = within(note).getByTestId("connection-direct-blocked-text");
    expect(story).toHaveTextContent("the app cannot tell which");
    expect(story).toHaveTextContent("never what they say");
    expect(story).toHaveTextContent("goes away when a direct connection works or the network changes");

    // The network changed, or a direct connection worked: the note goes by itself.
    act(() => view.engine.update({ transport: web, links: [relayed] }));
    expect(screen.queryByTestId("connection-direct-blocked")).toBeNull();
  });

  it("is not there on a network where direct connections work, nor in a chat kept on the DHT by choice", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: web, links: [relayed] }));
    await view.user.click(screen.getByTestId("connection-options"));
    expect(screen.queryByTestId("connection-direct-blocked")).toBeNull();
    act(() => view.engine.update({ transport: { ...web, directBlocked: true }, links: [linkView({ deliveryMode: "dht", textDelivery: "dht" })] }));
    expect(screen.queryByTestId("connection-direct-blocked")).toBeNull();
  });

  it("is in Settings, Network too, with the same words", async () => {
    const view = renderApp(<NetworkSettings />);
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-direct-blocked")).toBeNull();
    act(() => view.engine.update({ transport: { ...web, directBlocked: true }, settings: { relays: RELAYS } }));
    const row = screen.getByTestId("network-direct-blocked");
    expect(row).toHaveTextContent("Direct connections blocked");
    expect(row).toHaveTextContent(HINT);
    await view.user.click(within(row).getByTestId("row-info"));
    expect(within(row).getByTestId("row-info-text")).toHaveTextContent("Calls need a direct path or a TURN server");
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-direct-blocked")).toBeNull();
  });
});
