import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.status, chat.paired.verify, chat.paired.reconnect, transport.indicator, transport.chat-switch, transport.wait, invite.delivery-mode

type Pairing = NonNullable<LinkView["pairing"]>;
const ready = (patch: Partial<Pairing> = {}): Pairing => ({ status: "ready", transport: "webrtc/1", ...patch } as Pairing);
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

/** Renders the connection control for the chat with "peer" in the given state. */
function banner(link: Partial<LinkView>, state: StatePatch = {}, props: Partial<Parameters<typeof ChatConnection>[0]> = {}) {
  const view = renderApp(<ChatConnection peerKey="peer" {...props} />);
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
    // The label (and a failure), without the live connection's detail line.
    tooltip: screen.getByTestId("connection-tooltip").textContent!.replace(screen.queryByTestId("connection-tooltip-detail")?.textContent ?? "", ""),
    dot: dot ? [...dot.classList].find(c => c.startsWith("bg-")) : null,
    pulse: !!dot?.classList.contains("motion-safe:animate-pulse"),
  };
}

describe("ChatConnection: what the header says", () => {
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
    ["DHT-only delivery", { deliveryMode: "dht", dataLink: "idle" }, {}, { label: "DHT only · chosen by you", kind: "dht", dot: null, pulse: false }],
    ["on the DHT while live is retried", { textDelivery: "dht", pairing: ready() }, {}, { label: "On DHT · retrying live", kind: "dht", dot: "bg-text-muted", pulse: true }],
    ["DHT only, chosen by the contact", { textDelivery: "dht", pairing: ready(), dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } }, {}, { label: "DHT only · chosen by your contact", kind: "dht", dot: null, pulse: false }],
    ["a switch to HyperDHT", { pairing: ready({ transitionTarget: "hyperdht/1" }) }, {}, { label: "Switching · HyperDHT", kind: "waiting", dot: "bg-text-muted", pulse: true }],
    // A chosen transport not reached yet (WISP 100): waited for, never a connection issue.
    ["waiting on the DHT for a HyperDHT chosen with Fallback off", { textDelivery: "dht", dataLink: "idle", pairing: { status: "negotiating", transport: "iroh/1" } as Pairing,
      transportWait: { transport: "hyperdht/1", by: "you", reason: "unreachable", failures: 1, error: "Transport change failed: hyperdht/1 unreachable." } }, {},
      { label: "On DHT · waiting for HyperDHT", kind: "dht", dot: null, pulse: false }],
    ["waiting for a chosen HyperDHT before text can take the DHT", { textDelivery: "unavailable", dataLink: "idle", pairing: { status: "negotiating", transport: "iroh/1" } as Pairing,
      transportWait: { transport: "hyperdht/1", by: "you", reason: "unknown", failures: 0 } }, {}, { label: "Waiting for HyperDHT", kind: "waiting", dot: "bg-text-muted", pulse: false }],
    ["the first attempt for a transport chosen with Fallback off", { textDelivery: "dht", dataLink: "idle", pairing: { status: "negotiating", transport: "iroh/1", transitionTarget: "hyperdht/1" } as Pairing,
      transportWait: { transport: "hyperdht/1", by: "you", reason: "connecting", failures: 0 } }, {}, { label: "Switching · HyperDHT", kind: "waiting", dot: "bg-text-muted", pulse: true }],
    ["live on a fallback while a chosen transport waits", { pairing: ready({ transport: "iroh/1" }),
      transportWait: { transport: "hyperdht/1", by: "you", reason: "unreachable", live: "iroh/1", failures: 2 } }, {}, { label: "Connected · Iroh", kind: "connected", dot: "bg-accent", pulse: false }],
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

  it("shows only an icon in the header: its name and tooltip carry the state", () => {
    banner({ pairing: ready({ transport: "iroh/1" }), transportRttMs: 333 });
    expect(screen.getByTestId("connection-options")).toHaveTextContent(/^$/);
    expect(screen.getByTestId("connection-options")).toHaveAccessibleName("Connection options: Connected · Iroh");
    // The panel's first line has the round trip.
    expect(screen.getByTestId("connection-state")).toHaveTextContent("Connected · Iroh · 333 ms");
  });

  it("marks what is in use apart from what is chosen: WebRTC chosen, live over Iroh at 333 ms", () => {
    banner({ pairing: ready({ transport: "iroh/1" }), preferredTransport: "webrtc/1", transportAutomatic: false, transportRttMs: 333 });
    const webrtc = screen.getByRole("radio", { name: "WebRTC" }), iroh = screen.getByRole("radio", { name: "Iroh" });
    // The checked row is the choice; the row in use carries a short mark, and each row is one line.
    expect(webrtc).toHaveAttribute("aria-checked", "true");
    expect(webrtc).toHaveTextContent(/^WebRTC$/);
    expect(webrtc).toHaveAttribute("title", "WebRTC: Chosen · not in use");
    expect(iroh).toHaveAttribute("aria-checked", "false");
    expect(iroh).toHaveTextContent(/^IrohIn use · 333 ms$/);
    expect(iroh).toHaveAttribute("data-in-use", "");
    expect(within(screen.getByTestId("connection-summary")).getByText("Why").nextSibling).toHaveTextContent("You chose WebRTC for this chat; it is not available now, so the chat uses Iroh.");
  });

  it("keeps the rest under Details, closed: the keys, trust, the live path and the history", () => {
    banner({ pairing: ready(), peerParticipationKey: "saved", transportHistory: [{ at: Date.now(), kind: "live", transport: "webrtc/1", started: true }] }, {}, { myKey: "my-key" });
    const details = screen.getByTestId("connection-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    for (const id of ["connection-summary", "pair-trust", "connection-keys", "connection-history"]) expect(details).toContainElement(screen.getByTestId(id));
    // What stays out: the state line and the choice.
    for (const id of ["connection-state", "transport-options"]) expect(details).not.toContainElement(screen.getByTestId(id));
  });

  it("has both keys to copy, as the chat's Tech Info has them", async () => {
    const { user } = banner({ pairing: ready() }, {}, { myKey: "my-key-in-this-chat" });
    expect(screen.getByTestId("connection-key-you")).toHaveTextContent("my-key-in-this-chat");
    expect(screen.getByTestId("connection-key-contact")).toHaveTextContent("peer");
    await user.click(screen.getByTestId("connection-key-contact"));
    expect(await navigator.clipboard.readText()).toBe("peer");
    expect(screen.getByTestId("connection-key-contact")).toHaveTextContent("Copied!");
  });

  it("in a chat made with a v0.4 code, says its status and has the keys, with nothing to choose", () => {
    banner({}, {}, { paired: false, status: "Connected", myKey: "mine" });
    expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: Connected");
    expect(screen.getByTestId("connection-state")).toHaveTextContent("Connected");
    expect(screen.getByTestId("connection-key-you")).toHaveTextContent("mine");
    expect(screen.getByTestId("connection-key-contact")).toHaveTextContent("peer");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says why a transport is unavailable, on its option and below", () => {
    banner({ pairing: ready(), availableTransports: ["webrtc/1", "hyperdht/1"], transportErrors: { "iroh/1": "UDP blocked" }, peerTransports: ["webrtc/1"] });
    expect(screen.getByText("Iroh: UDP blocked")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Iroh" })).toHaveAttribute("title", "Iroh: UDP blocked");
    expect(screen.getByRole("radio", { name: "Iroh" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveAttribute("title", "HyperDHT: Your contact's app doesn't support HyperDHT");
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toBeDisabled();
  });

  it.each<[string, Partial<LinkView>, string]>([
    ["WebRTC", { pairing: ready() }, "webrtc/1"],
    ["Iroh", { pairing: ready({ transport: "iroh/1" }) }, "iroh/1"],
    ["HyperDHT", { pairing: ready({ transport: "hyperdht/1" }) }, "hyperdht/1"],
    ["a switch, still on the old one", { pairing: ready({ transport: "iroh/1", transitionTarget: "hyperdht/1" }) }, "iroh/1"],
  ])("shows the live transport's own mark in the header: %s", (_, link, transport) => {
    banner(link);
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-transport", transport);
    expect(screen.getByTestId("connection-options").querySelector("[data-transport-icon]")).toHaveAttribute("data-transport-icon", transport);
  });

  it.each<[string, Partial<LinkView>, StatePatch]>([
    ["DHT only", { deliveryMode: "dht", dataLink: "idle" }, {}],
    ["offline text", { textDelivery: "dht", pairing: ready() }, {}],
    ["offline", { pairing: ready() }, { settings: { online: false } }],
    ["connecting", { dataLink: "connecting", pairing: { status: "connecting", peerKey: "peer" } as Pairing }, {}],
  ])("shows no transport mark when not live: %s", (_, link, state) => {
    banner(link, state);
    expect(screen.getByTestId("connection-options")).not.toHaveAttribute("data-transport");
    expect(screen.queryByTestId("connection-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("connection-tooltip-detail")).not.toBeInTheDocument();
  });

  it("marks messages held for an away contact with their own glyph", () => {
    banner({ dataLink: "idle", peerOnline: false, peerParticipationKey: "saved", textDelivery: "hold" });
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-transport", "hold");
    expect(screen.getByTestId("connection-options").querySelector("[data-transport-icon]")).toHaveAttribute("data-transport-icon", "hold");
  });

  it("says in the tooltip and the popover what the connection is: transport, round trip, since when, why", () => {
    const since = Date.now() - 12 * 60_000 - 5_000;
    banner({ pairing: ready({ transport: "iroh/1" }), preferredTransport: "iroh/1", transportAutomatic: false, transportRttMs: 42, transportLive: { since, cause: "you" } });
    expect(screen.getByTestId("connection-tooltip-detail")).toHaveTextContent("42 ms · live for 12 min · your choice");
    const summary = screen.getByTestId("connection-summary");
    expect(within(summary).getByText("Transport").nextSibling).toHaveTextContent("Iroh");
    expect(within(summary).getByText("Round trip").nextSibling).toHaveTextContent("42 ms");
    expect(within(summary).getByText("Live since").nextSibling).toHaveTextContent("(12 min)");
    expect(within(summary).getByText("Why").nextSibling).toHaveTextContent("You chose Iroh for this chat.");
  });

  it.each<[string, Partial<LinkView>, string]>([
    ["automatic", { pairing: ready() }, "automatic"],
    ["the contact's choice", { pairing: ready({ transport: "hyperdht/1" }), transportLive: { since: Date.now(), cause: "contact" } }, "live for less than a minute · your contact's choice"],
    ["a fallback from the chosen one", { pairing: ready(), preferredTransport: "iroh/1", transportAutomatic: false }, "fallback"],
    ["the only one here", { pairing: ready(), availableTransports: ["webrtc/1"] }, "the only one here"],
  ])("says why this transport: %s", (_, link, line) => {
    banner(link);
    expect(screen.getByTestId("connection-tooltip-detail")).toHaveTextContent(line);
  });

  it("warns, instead of offering to verify, when the key does not match the saved contact", () => {
    banner({ peerParticipationKey: "saved", pairing: { status: "error", peerKey: "other", keyMismatch: true, code: "1234", error: "Different participation key" } as Pairing });
    expect(within(screen.getByTestId("pair-trust")).getByRole("alert")).toHaveTextContent("This key does not match the saved contact");
    expect(screen.queryByTestId("pair-verify")).not.toBeInTheDocument();
  });
});

describe("ChatConnection: what the panel does", () => {
  it("opens from the header and closes on Escape, handing focus back to the header", async () => {
    const { user } = banner({ pairing: ready() });
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    await user.click(screen.getByTestId("connection-options"));
    expect(menu.open).toBe(true);
    await user.keyboard("{Escape}");
    expect(menu.open).toBe(false);
    expect(screen.getByTestId("connection-options")).toHaveFocus();
  });

  it("offers the five choices, one chosen: Automatic, WebRTC, Iroh, HyperDHT and DHT only", () => {
    banner({ pairing: ready(), transportAutomatic: true, transportRttMs: 12 });
    expect(screen.getAllByRole("radio").map(r => [r.getAttribute("aria-label"), r.getAttribute("aria-checked"), r.textContent])).toEqual([
      ["Automatic", "true", "Automatic"], ["WebRTC", "false", "WebRTCIn use · 12 ms"], ["Iroh", "false", "Iroh"], ["HyperDHT", "false", "HyperDHT"], ["DHT only", "false", "DHT only"],
    ]);
  });

  it("turns DHT only on, and leaves it for a live connection", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setChatTransport", () => undefined);
    const choice = screen.getByRole("radio", { name: "DHT only" });
    expect(choice).toHaveAttribute("aria-checked", "false");
    await user.click(choice);
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
    act(() => engine.update({ links: [linkView({ availableTransports: all, deliveryMode: "dht", dataLink: "idle", transportAutomatic: true })] }));
    expect(screen.getByRole("radio", { name: "DHT only" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(engine.callsTo("setChatTransport")[1]).toEqual({ linkId: "link-1", transport: "auto" });
  });

  it("cannot change delivery while Ghostly is offline", () => {
    banner({ pairing: ready() }, { settings: { online: false } });
    for (const name of ["Automatic", "WebRTC", "Iroh", "HyperDHT", "DHT only"]) expect(screen.getByRole("radio", { name })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeDisabled();
  });

  it("on DHT only, offers every way back to a live connection, and keeps Fallback for then", () => {
    banner({ deliveryMode: "dht", dataLink: "idle" });
    expect(screen.getAllByRole("radio").filter(r => r.getAttribute("aria-checked") === "true").map(r => r.getAttribute("aria-label"))).toEqual(["DHT only"]);
    expect(screen.getAllByRole("radio").every(r => !(r as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole("radio", { name: "DHT only" })).toHaveAttribute("title", "DHT only: Short texts over the DHT, no live link · choose another to leave it");
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeDisabled();
  });

  it("picks a transport for this chat (the engine keeps the fallback choice)", async () => {
    const { user, engine } = banner({ pairing: ready(), availableTransports: ["webrtc/1", "iroh/1"], transportFallback: false, transportAutomatic: true });
    engine.on("setChatTransport", () => undefined);
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "WebRTC" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Iroh" }));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "iroh/1" }]);
  });

  it("in a WebRTC-only app lists every transport, WebRTC in use, the others disabled with the reason, and asks nothing", async () => {
    const { user, engine } = banner({ pairing: ready(), availableTransports: ["webrtc/1"], transportAutomatic: true });
    expect(screen.queryByRole("radio", { name: "Automatic" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "WebRTC" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "WebRTC" })).toBeEnabled();
    for (const native of ["Iroh", "HyperDHT"]) {
      expect(screen.getByRole("radio", { name: native })).toBeDisabled();
      expect(screen.getByRole("radio", { name: native })).toHaveAttribute("title", `${native}: ${native} needs Ghostly Desktop${native === "HyperDHT" ? ", or a HyperDHT relay in Settings" : ""}`);
    }
    await user.click(screen.getByRole("radio", { name: "WebRTC" }));
    expect(engine.callsTo("setChatTransport")).toEqual([]);
  });

  it("goes back to Automatic", async () => {
    const { user, engine } = banner({ pairing: ready(), preferredTransport: "hyperdht/1", transportAutomatic: false });
    engine.on("setChatTransport", () => undefined);
    await user.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "auto" }]);
  });

  it("asks again for the chosen transport when the chat ended up on another", async () => {
    const { user, engine } = banner({ pairing: ready(), preferredTransport: "iroh/1", transportAutomatic: false });
    engine.on("setChatTransport", () => undefined);
    expect(screen.getByRole("radio", { name: "Iroh" })).toHaveAttribute("title", "Iroh: Chosen · not in use");
    await user.click(screen.getByRole("radio", { name: "Iroh" }));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "iroh/1" }]);
  });

  it("does not ask again for the transport it is already on", async () => {
    const { user, engine } = banner({ pairing: ready(), preferredTransport: "webrtc/1", transportAutomatic: false });
    await user.click(screen.getByRole("radio", { name: "WebRTC" }));
    expect(engine.callsTo("setChatTransport")).toEqual([]);
  });

  it("turns the fallback off for the preferred transport", async () => {
    const { user, engine } = banner({ pairing: ready({ transport: "iroh/1" }), preferredTransport: "iroh/1" });
    engine.on("setTransportPreference", () => undefined);
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Fallback" }));
    expect(engine.callsTo("setTransportPreference")).toEqual([{ linkId: "link-1", preferred: "iroh/1", fallback: false }]);
  });

  it("shows what the engine refused, as a connection issue, and stays open", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setChatTransport", () => { throw new Error("The contact's app cannot do DHT-only"); });
    await user.click(screen.getByTestId("connection-options"));
    await user.click(screen.getByRole("radio", { name: "DHT only" }));
    expect((screen.getByTestId("connection-menu") as HTMLDetailsElement).open).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent("The contact's app cannot do DHT-only");
    expect(header()).toMatchObject({ kind: "failure", name: "Connection issue" });
  });

  it("says why the chat waits for its chosen transport, and when it tries again, with no connection issue", () => {
    const retryAt = new Date(2026, 8, 25, 13, 5).getTime();
    banner({ textDelivery: "dht", dataLink: "idle", peerNick: "Bea", pairing: { status: "negotiating", transport: "iroh/1" } as Pairing, preferredTransport: "hyperdht/1", transportAutomatic: false,
      transportWait: { transport: "hyperdht/1", by: "you", reason: "unreachable", failures: 1, error: "Transport change failed: hyperdht/1 unreachable. Retry or choose another transport.", retryAt } });
    const block = screen.getByTestId("connection-waiting");
    expect(block).toHaveAttribute("data-reason", "unreachable");
    expect(within(block).getByTestId("connection-waiting-why")).toHaveTextContent(`You chose HyperDHT. The last attempt failed: HyperDHT unreachable. Trying again at ${new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
    expect(block).toHaveTextContent("Short texts go through the DHT meanwhile; the rest waits.");
    expect(within(block).queryByRole("button", { name: "Use Automatic" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveAttribute("title", "HyperDHT: Chosen · waiting for it");
  });

  it("says plainly when the contact's app lacks the chosen transport, and offers Automatic", async () => {
    const { user, engine } = banner({ pairing: ready({ transport: "iroh/1" }), peerNick: "Bea", preferredTransport: "hyperdht/1", transportAutomatic: false,
      transportWait: { transport: "hyperdht/1", by: "you", reason: "contact-lacks", live: "iroh/1", failures: 0 } });
    engine.on("setChatTransport", () => undefined);
    const block = screen.getByTestId("connection-waiting");
    expect(within(block).getByTestId("connection-waiting-why")).toHaveTextContent("You chose HyperDHT. Bea's app doesn't have HyperDHT.");
    expect(block).toHaveTextContent("The chat stays on Iroh meanwhile.");
    // Live on Iroh: the header says so, and the choice is marked as waited for.
    expect(header()).toMatchObject({ kind: "connected", name: "Connected · Iroh" });
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveTextContent(/^HyperDHTWaiting$/);
    await user.click(within(block).getByRole("button", { name: "Use Automatic" }));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "auto" }]);
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

describe("ChatConnection: the connection history", () => {
  const t0 = Date.now() - 60 * 60_000;
  const history: NonNullable<LinkView["transportHistory"]> = [
    { at: t0, kind: "live", transport: "webrtc/1", started: true, rttMs: 30 },
    { at: t0 + 60_000, kind: "down", from: "webrtc/1", text: "dht" },
    { at: t0 + 90_000, kind: "attempt", reason: "Timed out" },
    { at: t0 + 100_000, kind: "live", transport: "webrtc/1", downMs: 40_000 },
    { at: t0 + 200_000, kind: "chose", cause: "contact", target: "iroh/1", transport: "webrtc/1" },
    { at: t0 + 201_000, kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "contact", rttMs: 12 },
    { at: t0 + 300_000, kind: "failed", target: "hyperdht/1", reason: "hyperdht/1 unreachable", transport: "iroh/1" },
  ];

  it("lists every event, newest first, drops and restarts included", async () => {
    const { user } = banner({ pairing: ready({ transport: "iroh/1" }), peerNick: "Ana", transportHistory: history });
    const panel = screen.getByTestId("connection-history");
    expect(within(panel).getByText("Connection history (7)")).toBeInTheDocument();
    await user.click(within(panel).getByText("Connection history (7)"));
    expect(within(panel).getAllByTestId("connection-history-event").map(e => [e.dataset.kind, e.querySelector("span")!.textContent])).toEqual([
      ["failed", "Couldn't switch to HyperDHT: HyperDHT unreachable"],
      ["switched", "Moved from WebRTC to Iroh · Ana's choice · 12 ms"],
      ["chose", "Ana chose Iroh"],
      ["live", "Live over WebRTC · after 40 s down"],
      ["attempt", "Connection attempt failed: Timed out"],
      ["down", "Live connection lost (WebRTC) · texts go through the DHT"],
      ["live", "Live over WebRTC · this app started · 30 ms"],
    ]);
    expect(within(panel).queryByTestId("connection-history-more")).toBeNull();
  });

  it("shows the latest twenty, and the rest on request", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ at: t0 + i * 1_000, kind: i % 2 ? "down" as const : "live" as const, transport: "webrtc/1" as const }));
    const { user } = banner({ pairing: ready(), transportHistory: many });
    await user.click(screen.getByText("Connection history (25)"));
    expect(screen.getAllByTestId("connection-history-event")).toHaveLength(20);
    await user.click(screen.getByTestId("connection-history-more"));
    expect(screen.getAllByTestId("connection-history-event")).toHaveLength(25);
  });

  it("is not there before the chat has any", () => {
    banner({ pairing: ready() });
    expect(screen.queryByTestId("connection-history")).toBeNull();
  });
});
