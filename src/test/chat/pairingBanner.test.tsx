import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { PairingBanner } from "../../components/PairingBanner";
import { linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.status, chat.paired.verify, chat.paired.reconnect

type Pairing = NonNullable<LinkView["pairing"]>;
const ready = (patch: Partial<Pairing> = {}): Pairing => ({ status: "ready", transport: "webrtc/1", ...patch } as Pairing);
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

/** Renders the banner for the chat with "peer" in the given state. */
function banner(link: Partial<LinkView>, state: StatePatch = {}) {
  const view = renderApp(<PairingBanner peerKey="peer" />);
  act(() => view.engine.update({ ...state, links: [linkView({ availableTransports: all, ...link })] }));
  return view;
}

/** Everything the header says about the state, in the four places it says it. */
function header() {
  const trigger = screen.getByTestId("connection-options");
  const dot = within(trigger).queryByTestId("connection-dot");
  return {
    kind: trigger.dataset.state,
    name: trigger.getAttribute("aria-label")!.replace("Connection options: ", ""),
    popover: screen.getByTestId("connection-state").textContent,
    tooltip: screen.getByTestId("connection-tooltip").textContent,
    dot: dot ? [...dot.classList].find(c => c.startsWith("bg-")) : null,
    pulse: !!dot?.classList.contains("motion-safe:animate-pulse"),
  };
}

describe("PairingBanner: what the header says", () => {
  // label, kind, dot colour and pulse for every branch of `label`, in the order the code checks them.
  it.each<[string, Partial<LinkView>, StatePatch, { label: string; kind: string; dot: string | null; pulse: boolean; failure?: string }]>([
    ["offline, even when connected", { pairing: ready() }, { settings: { online: false } }, { label: "Offline", kind: "offline", dot: null, pulse: false }],
    ["a pairing error", { dataLink: "idle", pairing: { status: "error", error: "Relay refused" } as Pairing }, {}, { label: "Connection issue", kind: "failure", dot: "bg-danger", pulse: false, failure: "Relay refused" }],
    ["a failed switch of transport", { pairing: ready({ transitionError: "Iroh did not answer" }) }, {}, { label: "Connection issue", kind: "failure", dot: "bg-danger", pulse: false, failure: "Iroh did not answer" }],
    ["a DHT error in DHT-only", { deliveryMode: "dht", dataLink: "idle", dhtDelivery: { error: "DHT put failed" } as LinkView["dhtDelivery"] }, {}, { label: "Connection issue", kind: "failure", dot: "bg-danger", pulse: false, failure: "DHT put failed" }],
    ["a DHT error with offline text", { textDelivery: "dht", pairing: ready(), dhtDelivery: { error: "DHT put failed" } as LinkView["dhtDelivery"] }, {}, { label: "Connection issue", kind: "failure", dot: "bg-danger", pulse: false, failure: "DHT put failed" }],
    ["discovery that could not be published", { dataLink: "idle", discoveryError: "Could not publish discovery: relay down" }, {}, { label: "Publication unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Could not publish discovery: relay down" }],
    ["discovery that could not be read", { dataLink: "idle", discoveryError: "Could not read discovery: timeout" }, {}, { label: "Discovery unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Could not read discovery: timeout" }],
    ["discovery that could be neither published nor read", { dataLink: "idle", discoveryError: "Could not publish discovery: a; Could not read discovery: b" }, {}, { label: "Discovery unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Could not publish discovery: a; Could not read discovery: b" }],
    ["DHT-only delivery", { deliveryMode: "dht", dataLink: "idle" }, {}, { label: "DHT only", kind: "dht", dot: null, pulse: false }],
    ["offline text over the DHT", { textDelivery: "dht", pairing: ready() }, {}, { label: "DHT · offline text", kind: "dht", dot: null, pulse: false }],
    ["a switch to HyperDHT", { pairing: ready({ transitionTarget: "hyperdht/1" }) }, {}, { label: "Switching · HyperDHT", kind: "waiting", dot: "bg-text-muted", pulse: true }],
    ["connected over WebRTC", { pairing: ready() }, {}, { label: "Connected · WebRTC", kind: "connected", dot: "bg-accent", pulse: false }],
    ["connected over Iroh", { pairing: ready({ transport: "iroh/1" }) }, {}, { label: "Connected · Iroh", kind: "connected", dot: "bg-accent", pulse: false }],
    ["connected over HyperDHT", { pairing: ready({ transport: "hyperdht/1" }) }, {}, { label: "Connected · HyperDHT", kind: "connected", dot: "bg-accent", pulse: false }],
    ["a peer to confirm", { dataLink: "connecting", pairing: { status: "confirm", peerKey: "other" } as Pairing }, {}, { label: "Confirm peer", kind: "waiting", dot: "bg-text-muted", pulse: false }],
    ["a new chat nobody joined", { dataLink: "idle", peerOnline: false, pairing: { status: "connecting" } as Pairing }, {}, { label: "No contact yet", kind: "waiting", dot: "bg-text-muted", pulse: false }],
    ["a known contact who is away", { dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" }, {}, { label: "Waiting for contact", kind: "waiting", dot: "bg-text-muted", pulse: false }],
    ["a connection on its way", { dataLink: "connecting", pairing: { status: "connecting", peerKey: "peer" } as Pairing }, {}, { label: "Connecting…", kind: "waiting", dot: "bg-text-muted", pulse: true }],
    ["ready but with the data channel not open yet", { dataLink: "connecting", pairing: ready() }, {}, { label: "Connecting…", kind: "waiting", dot: "bg-text-muted", pulse: true }],
  ])("%s", (_, link, state, want) => {
    banner(link, state);
    const view = header();
    expect(view).toMatchObject({ kind: want.kind, name: want.label, popover: want.label, dot: want.dot, pulse: want.pulse });
    expect(view.tooltip).toBe(want.label + (want.failure ?? ""));
    if (want.failure) expect(screen.getByRole("alert")).toHaveTextContent(want.failure);
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a discovery error once the chat is connected", () => {
    banner({ pairing: ready(), discoveryError: "Could not read discovery: stale" });
    expect(header()).toMatchObject({ kind: "connected", name: "Connected · WebRTC" });
    expect(screen.queryByTestId("discovery-help")).not.toBeInTheDocument();
  });

  it("explains a discovery failure and links to the relay settings", () => {
    banner({ dataLink: "idle", peerOnline: false, discoveryError: "Could not read discovery: timeout" });
    const help = screen.getByTestId("discovery-help");
    expect(help).toHaveTextContent(/^No contact yet\. Discovery will retry automatically/);
    expect(within(help).getByRole("link", { name: "review relay settings" })).toHaveAttribute("href", "/settings");
  });

  it("names the preferred transport when the chat is connected over another", () => {
    banner({ pairing: ready(), preferredTransport: "iroh/1" });
    expect(screen.getByText("Preferred: Iroh")).toBeInTheDocument();
  });

  it("says why a transport is unavailable, on its button and below", () => {
    banner({ pairing: ready(), availableTransports: ["webrtc/1"], transportErrors: { "iroh/1": "UDP blocked" } });
    expect(screen.getByText("Iroh: UDP blocked")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Iroh" }).closest("label")).toHaveAttribute("title", "UDP blocked");
    expect(screen.getByRole("radio", { name: "HyperDHT" }).closest("label")).toHaveAttribute("title", "Not available in this client");
  });

  it("warns, instead of offering to verify, when the key does not match the saved contact", () => {
    banner({ peerParticipationKey: "saved", pairing: { status: "error", peerKey: "other", keyMismatch: true, code: "1234", error: "Different participation key" } as Pairing });
    expect(within(screen.getByTestId("pair-trust")).getByRole("alert")).toHaveTextContent("This key does not match the saved contact");
    expect(screen.queryByTestId("pair-verify")).not.toBeInTheDocument();
  });
});

describe("PairingBanner: what the popover does", () => {
  it("opens from the header and closes on Escape, handing focus back to the header", async () => {
    const { user } = banner({ pairing: ready() });
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    await user.click(screen.getByTestId("connection-options"));
    expect(menu.open).toBe(true);
    await user.keyboard("{Escape}");
    expect(menu.open).toBe(false);
    expect(screen.getByTestId("connection-options")).toHaveFocus();
  });

  it("turns DHT-only delivery on, and off again", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setDeliveryMode", () => undefined);
    const toggle = screen.getByRole("switch", { name: "DHT-only delivery" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(engine.callsTo("setDeliveryMode")).toEqual([{ linkId: "link-1", mode: "dht" }]);
    act(() => engine.update({ links: [linkView({ availableTransports: all, deliveryMode: "dht" })] }));
    expect(screen.getByRole("switch", { name: "DHT-only delivery" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "DHT-only delivery" }));
    expect(engine.callsTo("setDeliveryMode")[1]).toEqual({ linkId: "link-1", mode: "stream" });
  });

  it("cannot change delivery while Ghostly is offline", () => {
    banner({ pairing: ready() }, { settings: { online: false } });
    expect(screen.getByRole("switch", { name: "DHT-only delivery" })).toBeDisabled();
    for (const name of ["WebRTC", "Iroh", "HyperDHT"]) expect(screen.getByRole("radio", { name })).toBeDisabled();
  });

  it("locks the transports while DHT-only is on, and says how to unlock them", () => {
    banner({ deliveryMode: "dht", dataLink: "idle" });
    expect(screen.getByText("Turn off DHT-only to choose a connection")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Iroh" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeDisabled();
  });

  it("picks a transport, keeping the fallback choice", async () => {
    const { user, engine } = banner({ pairing: ready(), availableTransports: ["webrtc/1", "iroh/1"], transportFallback: false });
    engine.on("setTransportPreference", () => undefined);
    expect(screen.getByRole("radio", { name: "WebRTC" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Iroh" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([{ linkId: "link-1", preferred: "iroh/1", fallback: false }]);
  });

  it("falls back by default when the chat never chose", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setTransportPreference", () => undefined);
    await user.click(screen.getByRole("radio", { name: "HyperDHT" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([{ linkId: "link-1", preferred: "hyperdht/1", fallback: true }]);
  });

  it("asks again for the preferred transport when the chat ended up on another", async () => {
    const { user, engine } = banner({ pairing: ready(), preferredTransport: "iroh/1" });
    engine.on("setTransportPreference", () => undefined);
    await user.click(screen.getByRole("radio", { name: "Iroh" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([{ linkId: "link-1", preferred: "iroh/1", fallback: true }]);
  });

  it("does not ask again for the transport it is already on", async () => {
    const { user, engine } = banner({ pairing: ready(), preferredTransport: "webrtc/1" });
    await user.click(screen.getByRole("radio", { name: "WebRTC" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([]);
  });

  it("turns the fallback off for the preferred transport", async () => {
    const { user, engine } = banner({ pairing: ready({ transport: "iroh/1" }), preferredTransport: "iroh/1" });
    engine.on("setTransportPreference", () => undefined);
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Fallback" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([{ linkId: "link-1", preferred: "iroh/1", fallback: false }]);
  });

  it("shows what the engine refused, as a connection issue", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setDeliveryMode", () => { throw new Error("The contact's app cannot do DHT-only"); });
    await user.click(screen.getByRole("switch", { name: "DHT-only delivery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The contact's app cannot do DHT-only");
    expect(header()).toMatchObject({ kind: "failure", name: "Connection issue" });
  });

  it("reconnects a chat that is not connected", async () => {
    const { user, engine } = banner({ dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" });
    engine.on("connect", () => undefined);
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(engine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
  });

  it.each<[string, Partial<LinkView>, StatePatch]>([
    ["connected", { pairing: ready() }, {}],
    ["DHT-only", { deliveryMode: "dht", dataLink: "idle" }, {}],
    ["nobody joined yet", { dataLink: "idle", peerOnline: false }, {}],
    ["offline", { dataLink: "idle" }, { settings: { online: false } }],
  ])("offers no Reconnect when %s", (_, link, state) => {
    banner(link, state);
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("verifies a contact: shows the code, then confirms it matched", async () => {
    const { user, engine } = banner({ peerParticipationKey: "saved", pairing: ready({ code: "4821 0937", peerKey: "peer" }) });
    engine.on("confirmPair", () => undefined);
    expect(screen.getByText("Key saved · not verified")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-code")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify this contact" }));
    expect(screen.getByTestId("pair-code")).toHaveTextContent("4821 0937");
    expect(screen.queryByRole("button", { name: "Verify this contact" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "The codes match" }));
    expect(engine.callsTo("confirmPair")).toEqual([{ linkId: "link-1", code: "4821 0937" }]);
    expect(screen.queryByTestId("pair-code")).not.toBeInTheDocument();
  });

  it("keeps the code on screen when the confirmation fails", async () => {
    const { user, engine } = banner({ peerParticipationKey: "saved", pairing: ready({ code: "4821 0937", peerKey: "peer" }) });
    engine.on("confirmPair", () => { throw new Error("The code changed"); });
    await user.click(screen.getByRole("button", { name: "Verify this contact" }));
    await user.click(screen.getByRole("button", { name: "The codes match" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The code changed");
    expect(screen.getByTestId("pair-code")).toBeInTheDocument();
  });

  it("says a verified contact is verified, and offers nothing more", () => {
    banner({ peerParticipationKey: "saved", peerVerified: true, pairing: ready({ code: "4821 0937", peerKey: "peer" }) });
    expect(screen.getByTestId("pair-verified")).toHaveTextContent("Codes verified");
    expect(screen.queryByTestId("pair-verify")).not.toBeInTheDocument();
    expect(screen.getByText("You compared codes with this contact. The key is pinned and unchanged.")).toBeInTheDocument();
  });

  it("offers no verification before there is a code to compare", () => {
    banner({ peerParticipationKey: "saved", pairing: ready({ peerKey: "peer" }) });
    expect(screen.getByText("Key saved · not verified")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-verify")).not.toBeInTheDocument();
  });
});
