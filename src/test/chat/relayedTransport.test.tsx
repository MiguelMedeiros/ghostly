import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { connectionSummary, transportLineDetails, transportLineText, transportOptions, type TransportEntry } from "../../lib/transportEvents";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.relayed, transport.indicator, transport.chat-switch

type Pairing = NonNullable<LinkView["pairing"]>;
const onHyperdht = { status: "ready", transport: "hyperdht/1" } as Pairing;
/** A browser whose HyperDHT goes through a relay, talking to a contact on WebRTC and HyperDHT. */
const web: Partial<LinkView> = {
  availableTransports: ["webrtc/1", "hyperdht/1"], peerTransports: ["webrtc/1", "iroh/1", "hyperdht/1"], relayedTransports: ["hyperdht/1"], transportAutomatic: true,
};

describe("a relayed transport", () => {
  it("is offered, and marked as a relay the apps use when nothing direct connects", () => {
    expect(transportOptions(web)).toEqual([
      { transport: "webrtc/1", available: true },
      { transport: "iroh/1", available: false, reason: "Iroh needs Ghostly Desktop" },
      { transport: "hyperdht/1", available: true, relayed: true },
    ]);
  });

  it("says relayed wherever the live connection is described, which relay, and what it sees", () => {
    const link = linkView({ ...web, pairing: onHyperdht, dataLink: "open", transportRttMs: 180, transportRelayed: { relays: ["relay.example"] } });
    const summary = connectionSummary(link, Date.now())!;
    expect(summary.relays).toEqual(["relay.example"]);
    expect(summary.line).toBe("HyperDHT · relayed · 180 ms · no direct path");
    expect(summary.why).toContain("Relayed: relay.example sees which devices talk and when, never what they say.");
    // The same transport between two Desktops is direct, and says nothing of a relay.
    const direct = connectionSummary(linkView({ ...web, relayedTransports: [], pairing: onHyperdht, dataLink: "open" }), Date.now())!;
    expect(direct.relays).toBeUndefined();
    expect(direct.line).not.toContain("relay");
  });

  it("is named in the chat's timeline, not called a direct path", () => {
    const entry: TransportEntry = { id: "l", at: 0, kind: "switched", cause: "automatic", from: "webrtc/1", transport: "hyperdht/1", relayed: true };
    expect(transportLineText(entry, "Ana")).toBe("Moved to HyperDHT, through a relay");
    expect(transportLineDetails(entry, "Ana", () => "14:02")[0]).toEqual({ label: "Transport", value: "HyperDHT · relayed" });
    expect(transportLineText({ ...entry, relayed: undefined }, "Ana")).toBe("Moved to HyperDHT, a direct path was found");
  });

  it("shows in the header's connection control and in its panel", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ links: [linkView({ ...web, pairing: onHyperdht, dataLink: "open", transportRttMs: 180, transportRelayed: { relays: ["relay.example"] } })] }));
    expect(screen.getByTestId("connection-now")).toHaveTextContent("HyperDHT · relayed· 180 ms");
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-relayed", "");
    await view.user.click(screen.getByTestId("connection-options"));
    const panel = screen.getByRole("dialog", { name: "Connection options" });
    expect(within(panel).getByTestId("connection-in-use")).toHaveTextContent("HyperDHT · relayed");
    expect(within(panel).getByTestId("connection-option-hyperdht")).toHaveTextContent("In use · relayed · 180 ms");
    expect(within(panel).getByTestId("connection-relayed")).toHaveTextContent("Relayed via relay.example");
    expect(within(panel).getByTestId("connection-summary")).toHaveTextContent("never what they say");
  });

  it("when not in use, says it goes through a relay", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ links: [linkView({ ...web, pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    await view.user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-option-hyperdht")).toHaveTextContent("Through a relay · used when nothing direct connects");
  });
});
