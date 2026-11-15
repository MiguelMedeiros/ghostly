import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection, MOVE_QUIET_MS } from "../../components/ChatConnection";
import { connectionSummary, liveAttemptText, transportLineDetails, transportLineText, transportOptions, type TransportEntry, transportEventText, transportWaitText, type TransportEvent } from "../../lib/transportEvents";
import { linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { clockOffAmount } from "../../lib/clockOff";
import { NetworkSettings } from "../../components/NetworkSettings";
import { LOCALES as locales, LANGUAGES, LOCALES } from "../i18n/locales";
import type { LiveAttempt } from "@ghostly/core";
import type { Language } from "../../lib/settings";
import { translateWith } from "../../locales/translate";

// covers: chat.paired.discovery-health, chat.paired.status, chat.paired.verify, chat.paired.reconnect, transport.indicator, transport.chat-switch, transport.wait, invite.delivery-mode

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
    ["discovery that could not be published", { dataLink: "idle", discoveryError: "Could not publish discovery: relay down" }, {}, { label: "Publication unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Can't reach the relays" }],
    ["discovery that could not be read", { dataLink: "idle", discoveryError: "Could not read discovery: timeout" }, {}, { label: "Discovery unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Can't reach the relays" }],
    ["discovery that could be neither published nor read", { dataLink: "idle", discoveryError: "Could not publish discovery: a; Could not read discovery: b" }, {}, { label: "Discovery unavailable", kind: "failure", dot: "bg-danger", pulse: false, failure: "Can't reach the relays" }],
    ["DHT-only delivery", { deliveryMode: "dht", dataLink: "idle" }, {}, { label: "DHT only · chosen by you", kind: "dht", dot: null, pulse: false }],
    ["on the DHT while live is retried", { textDelivery: "dht", pairing: ready() }, {}, { label: "On DHT · retrying live", kind: "dht", dot: "bg-text-muted", pulse: true }],
    ["DHT only, chosen by the contact", { textDelivery: "dht", pairing: ready(), dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } }, {}, { label: "DHT only · chosen by your contact", kind: "dht", dot: null, pulse: false }],
    // Held messages take the place of the DHT for text (WISP 404): the label said "Connecting…" for as long as the contact was away.
    ["DHT only, chosen by the contact, with messages held", { textDelivery: "hold", dataLink: "idle", peerParticipationKey: "saved", pairing: { status: "connecting", peerKey: "peer" } as Pairing,
      dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } }, {}, { label: "DHT only · chosen by your contact", kind: "dht", dot: null, pulse: false }],
    ["messages held for a contact who is away", { textDelivery: "hold", dataLink: "connecting", peerOnline: false, peerParticipationKey: "saved", pairing: { status: "connecting", peerKey: "peer" } as Pairing }, {},
      { label: "Away · messages are held", kind: "waiting", dot: "bg-text-muted", pulse: false }],
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

  // The web app started from its cache with no network (r10a): the relays fail, the DHT read fails, and the banner says
  // Offline. The header said "Connection issue" in red, with the relays' raw English, until the network came back.
  it.each<[string, Partial<LinkView>]>([
    ["no relay reachable", { textDelivery: "dht", dataLink: "idle", pairing: ready(), dhtDelivery: { error: "Could not read DHT delivery: No Pkarr relay reachable" } as LinkView["dhtDelivery"] }],
    ["discovery that could not be published", { dataLink: "idle", discoveryError: "Could not publish discovery: Publish failed on every relay: Error: https://a.test did not answer a moment ago; retry shortly" }],
    ["a live session the network has not dropped yet", { pairing: ready() }],
  ])("says Offline when the device has no network, whatever the relays answer: %s", (_, link) => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    banner(link);
    expect(header()).toMatchObject({ kind: "offline", name: "Offline", popover: "Offline", tooltip: "Offline", dot: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pkarr|relay/)).not.toBeInTheDocument();
    // Ghostly's own switch is on: the transport stays a choice to make for when the network is back.
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeEnabled();
  });

  // The contact chose DHT only: its app closes the live link, and this side learns the choice from its DHT envelope, one
  // read of the mailbox later (about 10 s). Meanwhile the header said "retrying live", with a breathing dot.
  describe("just after a live link closed", () => {
    const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved", pairing: { status: "ready", peerKey: "peer" } as Pairing };
    const down = (at: number, more: Partial<NonNullable<LinkView["transportHistory"]>[number]> = {}): Partial<LinkView> =>
      ({ transportHistory: [{ at: at - 60_000, kind: "live", transport: "webrtc/1", started: true }, { at, kind: "down", from: "webrtc/1", text: "dht", ...more }] });

    it("says it is on the DHT, with no retry, for the first seconds, and retrying live after", () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        banner({ ...onDht, ...down(Date.now() - 2_000) });
        expect(header()).toMatchObject({ kind: "dht", name: "On DHT", popover: "On DHT", dot: null, pulse: false });
        expect(screen.getByTestId("connection-options")).not.toHaveAttribute("data-busy");
        act(() => { vi.advanceTimersByTime(13_000); });
        expect(header()).toMatchObject({ kind: "dht", name: "On DHT · retrying live", dot: "bg-text-muted", pulse: true });
      } finally { vi.useRealTimers(); }
    });

    it("is DHT only, chosen by the contact, as soon as its envelope says so", () => {
      const view = banner({ ...onDht, ...down(Date.now() - 2_000) });
      act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...onDht, ...down(Date.now() - 3_000),
        dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } })] }));
      expect(header()).toMatchObject({ kind: "dht", name: "DHT only · chosen by your contact", dot: null, pulse: false });
    });

    it.each<[string, Partial<LinkView>]>([
      ["it closed long ago", down(Date.now() - 20_000)],
      ["the stretch is from before this app started", down(Date.now() - 1_000, { restart: true })],
      ["no live link closed", {}],
    ])("says retrying live when %s", (_, history) => {
      banner({ ...onDht, ...history });
      expect(header()).toMatchObject({ kind: "dht", name: "On DHT · retrying live", dot: "bg-text-muted", pulse: true });
    });

    // With held messages on, the same close said "Away · messages are held" with Reconnect at once: the contact was
    // online, and the engine refuses the dial while they keep DHT only.
    describe("with messages held", () => {
      const held: Partial<LinkView> = { textDelivery: "hold", dataLink: "idle", peerOnline: true, peerParticipationKey: "saved", pairing: { status: "connecting", peerKey: "peer" } as Pairing };
      const downHeld = (at: number) => down(at, { text: "hold" });
      const reconnect = () => screen.queryByRole("button", { name: "Reconnect" });

      it("says the messages are held, not that the contact is away, and offers no Reconnect for the first seconds", () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          banner({ ...held, ...downHeld(Date.now() - 2_000) });
          expect(header()).toMatchObject({ name: "Messages are held", popover: "Messages are held", pulse: false });
          expect(reconnect()).not.toBeInTheDocument();
          act(() => { vi.advanceTimersByTime(13_000); });
          expect(header()).toMatchObject({ kind: "waiting", name: "Away · messages are held" });
          expect(reconnect()).toBeInTheDocument();
        } finally { vi.useRealTimers(); }
      });

      it("is DHT only, chosen by the contact, with no Reconnect, as soon as its envelope says so", () => {
        const view = banner({ ...held, ...downHeld(Date.now() - 2_000) });
        act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...held, ...downHeld(Date.now() - 3_000),
          dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } })] }));
        expect(header()).toMatchObject({ kind: "dht", name: "DHT only · chosen by your contact", dot: null, pulse: false });
        expect(reconnect()).not.toBeInTheDocument();
      });

      it("says the contact is away when the link closed long ago", () => {
        banner({ ...held, ...downHeld(Date.now() - 20_000) });
        expect(header()).toMatchObject({ kind: "waiting", name: "Away · messages are held" });
        expect(reconnect()).toBeInTheDocument();
      });
    });
  });

  // The Linux Desktop with Hide my IP on and no HyperDHT relay: no WebRTC in WebKitGTK, its own Iroh and HyperDHT left
  // out for contacts. Nothing can go live, yet the header said "retrying live", breathing, with Reconnect, for as long
  // as the switch stayed on: the engine's dials each ended at once ("No transport both apps allow").
  describe("with Hide my IP on and no transport this app can run", () => {
    const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved", pairing: { status: "ready", peerKey: "peer" } as Pairing,
      availableTransports: [], runnableTransports: [], peerTransports: ["iroh/1", "hyperdht/1"] };
    const reconnect = () => screen.queryByRole("button", { name: "Reconnect" });

    it("says it is on the DHT, with no retry and no Reconnect, and why", () => {
      banner(onDht, { settings: { relayOnly: true } });
      expect(header()).toMatchObject({ kind: "dht", name: "On DHT", popover: "On DHT", dot: null, pulse: false });
      expect(reconnect()).not.toBeInTheDocument();
      expect(screen.getByTestId("connection-live-off")).toHaveTextContent("With Hide my IP on, HyperDHT needs a HyperDHT relay · Settings, Network");
    });

    it.each<[string, Partial<LinkView>, StatePatch]>([
      ["a HyperDHT relay is set", { runnableTransports: ["hyperdht/1"] }, { settings: { relayOnly: true } }],
      ["Hide my IP is off", {}, {}],
    ])("retries live as before when %s", (_, more, state) => {
      banner({ ...onDht, ...more }, state);
      expect(header()).toMatchObject({ kind: "dht", name: "On DHT · retrying live", pulse: true });
      expect(reconnect()).toBeInTheDocument();
      expect(screen.queryByTestId("connection-live-off")).not.toBeInTheDocument();
    });
  });

  it("is back to what the connection says once the device is online again", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    banner({ pairing: ready() });
    expect(header()).toMatchObject({ kind: "offline", name: "Offline" });
    onLine.mockReturnValue(true);
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(header()).toMatchObject({ kind: "connected", name: "Connected · WebRTC" });
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
    expect(within(help).getByRole("link", { name: "review relay settings" })).toHaveAttribute("href", "/settings/network");
  });

  it("shows only an icon in the header: its name and tooltip carry the state", () => {
    banner({ pairing: ready({ transport: "iroh/1" }), transportRttMs: 333 });
    expect(screen.getByTestId("connection-options")).toHaveTextContent(/^$/);
    expect(screen.getByTestId("connection-options")).toHaveAccessibleName("Connection options: Connected · Iroh");
    // The panel's first line has the round trip.
    expect(screen.getByTestId("connection-state")).toHaveTextContent("Connected · Iroh · 333 ms");
  });

  it("isolates the round trip on the panel's first line, so in Arabic its number stays by its unit, not by the transport", () => {
    banner({ pairing: ready({ transport: "webrtc/1" }), transportRttMs: 4 });
    const rtt = screen.getByTestId("connection-rtt");
    expect(rtt.tagName).toBe("BDI");
    expect(rtt).toHaveTextContent(/^4 ms$/);
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
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveAttribute("title", "Your contact's app doesn't support HyperDHT");
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toBeDisabled();
  });

  it("says a transport's listener error in the app's language, with its next step", () => {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language: "pt" });
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1"], pairing: ready(), transportErrors: {
      "hyperdht/1": "Could not reach the HyperDHT relay",
      "iroh/1": "All native connection slots are in use. This chat takes one once a chat live over one has been quiet for 2 minutes. Disconnect a native connection in another chat to free one now.",
    } })] }));
    const [hyperdht, iroh] = screen.getAllByTestId("connection-transport-error");
    expect(within(hyperdht!).getByTestId("connection-transport-error-title")).toHaveTextContent(/^Relay HyperDHT inacessível$/);
    expect(within(hyperdht!).getByTestId("connection-transport-error-next")).toHaveTextContent("Confira o endereço em Ajustes → Rede. Ele também pode não aceitar este app: pergunte a quem o mantém.");
    expect(within(iroh!).getByTestId("connection-transport-error-title")).toHaveTextContent("Iroh: Todas as conexões nativas em uso");
    expect(within(iroh!).getByTestId("connection-transport-error-next")).toHaveTextContent("Desconecte a conexão nativa de outra conversa, ou espere uma ficar ociosa.");
    // The option says the same few words: its tooltip, its description and its second line on a phone.
    const option = screen.getByRole("radio", { name: "Iroh" });
    expect(option).toHaveAttribute("title", "Iroh: Todas as conexões nativas em uso");
    expect(option).toHaveAttribute("aria-description", "Todas as conexões nativas em uso");
    expect(option).toHaveTextContent("Todas as conexões nativas em uso");
    expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveAttribute("title", "Relay HyperDHT inacessível");
  });

  it.each<[string, string, Record<string, string>]>([
    ["en", "en", {
      "Could not reach the HyperDHT relay": "HyperDHT relay unreachable",
      "The HyperDHT relay did not answer": "HyperDHT relay not answering",
      "The HyperDHT relay closed the connection": "HyperDHT relay closed the connection",
      "The HyperDHT relay did not let this chat listen": "HyperDHT relay refused this chat",
    }],
    ["ja", "ja", {
      "Could not reach the HyperDHT relay": "HyperDHTリレーに接続できません",
      "The HyperDHT relay did not answer": "HyperDHTリレーが応答しません",
      "The HyperDHT relay closed the connection": "HyperDHTリレーが接続を閉じました",
      "The HyperDHT relay did not let this chat listen": "HyperDHTリレーがこのチャットを拒否しました",
    }],
  ])("names HyperDHT once for a relay error, below and on its option (%s)", (_, language, said) => {
    for (const [error, title] of Object.entries(said)) {
      const view = renderApp(<ChatConnection peerKey="peer" />, { language: language as "en" | "ja" });
      act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1"], pairing: ready(), transportErrors: { "hyperdht/1": error } })] }));
      expect(screen.getByTestId("connection-transport-error-title")).toHaveTextContent(new RegExp(`^${title}$`));
      expect(screen.getByRole("radio", { name: "HyperDHT" })).toHaveAttribute("title", title);
      view.unmount();
    }
  });

  it("says the Iroh WASM's relay error in the app's language, pointing to Settings, Network", () => {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language: "ar" });
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1"], pairing: ready(), transportErrors: { "iroh/1": "Iroh relay unreachable" } })] }));
    const notice = screen.getByTestId("connection-transport-error");
    // The reason names Iroh already, so the line does not put "Iroh:" before it.
    expect(within(notice).getByTestId("connection-transport-error-title")).toHaveTextContent(/^تعذّر الوصول إلى مُرحِّل Iroh$/);
    expect(within(notice).getByTestId("connection-transport-error-next")).toHaveTextContent("تحقّق من مرحّلات Iroh في الإعدادات، الشبكة، أو استخدم وسيلة نقل أخرى.");
    expect(notice).not.toHaveTextContent("Iroh relay unreachable");
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

  it("says, only in Details, that someone else publishes on the invite's keys, and stays connected", () => {
    // covers: chat.dht.key-change
    banner({ pairing: ready(), dhtDelivery: { mode: "stream", authenticated: true, maxTextBytes: 256, foreignKeySeenAt: Date.now() } });
    expect(header()).toMatchObject({ kind: "connected" });
    expect(screen.getByTestId("connection-tooltip")).not.toHaveTextContent("invite keys");
    const warning = within(screen.getByTestId("connection-details")).getByTestId("connection-foreign-key");
    expect(warning).toHaveTextContent("Someone else is publishing on this chat's invite keys");
    expect(warning).not.toHaveAttribute("role", "alert");
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

  // At 375 px the panel is a fixed overlay over the messages: a Tab past its end went on to the buttons under it.
  it("closes when Tab takes the focus out of it, leaving the focus where it went", async () => {
    const view = renderApp(<><ChatConnection peerKey="peer" /><button type="button">Next in the header</button></>);
    act(() => view.engine.update({ links: [linkView({ availableTransports: all, pairing: ready() })] }));
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    await view.user.click(screen.getByTestId("connection-options"));
    await view.user.click(screen.getByTestId("connection-details-summary"));
    // A click on the panel's text moves the focus nowhere in particular: the panel stays.
    await view.user.click(screen.getByTestId("connection-state"));
    expect(menu.open).toBe(true);
    screen.getByTestId("connection-key-contact").focus();
    await view.user.tab();
    expect(screen.getByRole("button", { name: "Next in the header" })).toHaveFocus();
    expect(menu.open).toBe(false);
  });

  // On a computer the page is a focusable <main tabIndex={-1}> (App.tsx): a press on the panel's text gave the focus to
  // it, and the panel took that for focus gone elsewhere and closed, so its relay and path could not be selected.
  it("stays open while its text is pressed and dragged over to select it, inside the page's focusable main", async () => {
    const view = renderApp(<main tabIndex={-1}><ChatConnection peerKey="peer" /><p>A message</p></main>);
    act(() => view.engine.update({ links: [linkView({ availableTransports: all, relayedTransports: ["iroh/1"], dataLink: "open",
      pairing: ready({ transport: "iroh/1" }), transportRelayed: { relays: ["relay.example"] } })] }));
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    await view.user.click(screen.getByTestId("connection-options"));
    await view.user.click(screen.getByTestId("connection-details-summary"));
    const relayed = screen.getByTestId("connection-relayed"), why = within(screen.getByTestId("connection-summary")).getByText(/never what they say/);
    await view.user.pointer([{ keys: "[MouseLeft>]", target: relayed, offset: 0 }, { target: relayed, offset: 12 }, { target: why }, { keys: "[/MouseLeft]" }]);
    expect(menu.open).toBe(true);
    await view.user.click(relayed);
    expect(menu.open).toBe(true);
    // A press outside it still closes it.
    await view.user.click(screen.getByText("A message"));
    expect(menu.open).toBe(false);
  });

  it("stays open while Tab goes round its own controls", async () => {
    const { user } = banner({ pairing: ready() });
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    await user.click(screen.getByTestId("connection-options"));
    await user.tab();
    expect(screen.getByTestId("connection-menu")).toContainElement(document.activeElement as HTMLElement);
    expect(menu.open).toBe(true);
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
      expect(screen.getByRole("radio", { name: native })).toHaveAttribute("title", `${native} needs Ghostly Desktop${native === "HyperDHT" ? ", or a HyperDHT relay in Settings" : ""}`);
    }
    await user.click(screen.getByRole("radio", { name: "WebRTC" }));
    expect(engine.callsTo("setChatTransport")).toEqual([]);
  });

  it("in an app with no WebRTC (Linux Desktop), Automatic and the summary say what Automatic does there", () => {
    const link = { pairing: ready({ transport: "hyperdht/1" }), availableTransports: ["iroh/1", "hyperdht/1"] as LinkView["availableTransports"], peerTransports: all, transportAutomatic: true };
    banner(link);
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute("title", "Automatic: The apps choose, Iroh first");
    // The contact's app ranks WebRTC first: "both apps rank HyperDHT first" would be untrue.
    expect(connectionSummary(linkView(link), Date.now())?.why).toBe("Automatic: the apps use HyperDHT, which both have; one of them has no WebRTC.");
    expect(connectionSummary(linkView({ ...link, availableTransports: all, peerTransports: ["iroh/1", "hyperdht/1"] }), Date.now())?.why)
      .toBe("Automatic: the apps use HyperDHT, which both have; one of them has no WebRTC.");
    expect(connectionSummary(linkView({ ...link, availableTransports: all }), Date.now())?.why).toBe("Automatic: both apps rank HyperDHT first.");
  });

  it("in the web app with Iroh, Automatic says it puts Iroh first, and on WebRTC that it came back over Iroh and moved", () => {
    const web = ["webrtc/1", "iroh/1"] as LinkView["availableTransports"];
    const link = { pairing: ready({ transport: "webrtc/1" }), availableTransports: web, peerTransports: web, transportAutomatic: true };
    banner(link);
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute("title", "Automatic: The apps choose, Iroh first");
    expect(connectionSummary(linkView(link), Date.now())?.why)
      .toBe("Automatic: the apps put Iroh first, which is back almost at once, and move to WebRTC once connected, which is faster.");
    // A contact with no Iroh: WebRTC first, as before.
    expect(connectionSummary(linkView({ ...link, peerTransports: ["webrtc/1"] as LinkView["availableTransports"] }), Date.now())?.why)
      .toBe("Automatic: both apps rank WebRTC first, and a first pairing always uses WebRTC.");
    // Fallback off: Automatic puts WebRTC first, as before (it would otherwise stay on Iroh's relay for good).
    expect(connectionSummary(linkView({ ...link, transportFallback: false }), Date.now())?.why)
      .toBe("Automatic: both apps rank WebRTC first, and a first pairing always uses WebRTC.");
    // Left on Iroh's relay: WebRTC could not connect.
    expect(connectionSummary(linkView({ ...link, pairing: ready({ transport: "iroh/1" }), transportRelayed: { relays: ["relay.test"] } }), Date.now())?.why)
      .toBe("Automatic: a direct connection could not be made, so the chat goes through Iroh's relay. Relayed: relay.test sees which devices talk and when, never what they say.");
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

  // Beside Details, Reconnect took a column down the whole open Details: they shrank from 294 to 210 px and relay
  // host names broke mid-word, just when the chat is down and Details are read the most.
  it("puts Reconnect on its own row above Details, which keep the panel's width", () => {
    banner({ dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" });
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    const details = screen.getByTestId("connection-details");
    expect(reconnect.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details.parentElement).not.toHaveClass("flex");
    expect(details).not.toHaveClass("flex-1");
  });

  // The contact's daemon was down when Reconnect was pressed, then came back and the chat went live by itself: the
  // header stayed a red "Connection issue" with the old refusal until the menu was used again.
  it("forgets a failed Reconnect once the chat is live again by itself", async () => {
    const away = { dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" } as Partial<LinkView>;
    const { user, engine } = banner(away);
    engine.on("connect", () => { throw new Error("Could not connect to the peer"); });
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByTestId("connection-failure")).toHaveTextContent("Could not connect to the peer");
    expect(header()).toMatchObject({ kind: "failure", name: "Connection issue" });
    act(() => engine.update({ links: [linkView({ availableTransports: all, ...away, dataLink: "open", peerOnline: true, pairing: ready({ peerKey: "peer" }) })] }));
    expect(header()).toMatchObject({ kind: "connected", name: "Connected · WebRTC" });
    expect(screen.queryByTestId("connection-failure")).not.toBeInTheDocument();
  });

  // The engine's dial waits up to 90 s for an away contact: Reconnect held the whole panel off for that long (DHT only,
  // Fallback, Reconnect), said nothing, and dropped the focus to the page. Measured on a web build: 90 s.
  it("leaves the panel usable while Reconnect waits for the contact, and a choice meanwhile takes over", async () => {
    const away = { dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" } as Partial<LinkView>;
    const { user, engine } = banner(away);
    let refuse: (e: Error) => void = () => {};
    engine.on("connect", () => new Promise<void>((_, reject) => { refuse = reject; }));
    engine.on("setChatTransport", () => undefined);
    await user.click(screen.getByTestId("connection-options"));
    const button = screen.getByRole("button", { name: "Reconnect" });
    await user.click(button);
    const dhtOnly = screen.getByRole("radio", { name: "DHT only" });
    expect(dhtOnly).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Fallback" })).toBeEnabled();
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent("Reconnecting…");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(engine.callsTo("connect")).toHaveLength(1);
    await user.click(dhtOnly);
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
    // DHT only closed the dial: its refusal is not the chat's connection issue.
    await act(async () => refuse(new Error("Connection attempt cancelled")));
    expect(screen.queryByTestId("connection-failure")).not.toBeInTheDocument();
  });

  it("keeps a failed choice made while live: it is about that choice, not about getting live", async () => {
    const { user, engine } = banner({ pairing: ready() });
    engine.on("setChatTransport", () => { throw new Error("Transport unavailable"); });
    await user.click(screen.getByRole("radio", { name: "Iroh" }));
    expect(await screen.findByTestId("connection-failure")).toBeInTheDocument();
    act(() => engine.update({ links: [linkView({ availableTransports: all, pairing: ready(), transportRttMs: 40 })] }));
    expect(screen.getByTestId("connection-failure")).toBeInTheDocument();
  });

  it.each<[string, Partial<LinkView>, StatePatch]>([
    ["connected", { pairing: ready() }, {}],
    ["DHT-only", { deliveryMode: "dht", dataLink: "idle" }, {}],
    // The engine refuses a dial while the contact keeps the chat on DHT only, and the refusal read as a connection issue.
    ["the contact keeps it on DHT only", { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved", pairing: { status: "ready", peerKey: "peer" } as Pairing,
      dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } }, {}],
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
    engine.on("confirmPair", () => { throw new Error("No authenticated peer to verify"); });
    await user.click(screen.getByRole("button", { name: "Verify this contact" }));
    await user.click(screen.getByRole("button", { name: "The codes match" }));
    expect(await screen.findByTestId("pair-verify-error")).toHaveTextContent("No authenticated peer to verify");
    expect(screen.getByTestId("pair-code")).toBeInTheDocument();
  });

  // The connection changed or closed between showing the code and the click: a code to compare again, said in the
  // app's language beside the code. It is no connection issue: the chat's icon stays as it was.
  it.each([
    ["The connection changed. Compare the current code again.", "O código mudou", "Compare o novo código."],
    ["Compare the current code again.", "O código mudou", "Compare o novo código."],
    ["The connection closed. Compare again after reconnecting.", "A conexão foi fechada", "Compare de novo depois de reconectar."],
  ])("says a refused comparison beside the code, never as a connection issue: %s", async (raw, title, next) => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />, { language: "pt" });
    act(() => engine.update({ links: [linkView({ availableTransports: all, peerParticipationKey: "saved", pairing: ready({ code: "4821 0937", peerKey: "peer" }) })] }));
    const before = header();
    engine.on("confirmPair", () => { throw new Error(raw); });
    await user.click(screen.getByTestId("pair-verify"));
    await user.click(screen.getByTestId("pair-verify-confirm"));
    expect(await screen.findByTestId("pair-verify-error-title")).toHaveTextContent(title);
    expect(screen.getByTestId("pair-verify-error-next")).toHaveTextContent(next);
    expect(screen.getByTestId("pair-verify-error")).not.toHaveAttribute("data-tone", "error");
    expect(screen.queryByTestId("connection-failure")).not.toBeInTheDocument();
    expect(header()).toEqual(before);
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

describe("ChatConnection: how contacts are found", () => {
  it("says DHT direct and each relay's health under Details", () => {
    const until = new Date(2026, 8, 26, 14, 5).getTime();
    banner({ pairing: ready() }, { transport: { direct: true, discovery: { path: { via: "dht" }, relays: [
      { relay: "https://pkarr.pubky.org", state: "ok" },
      { relay: "https://pkarr.pubky.app", state: "throttled", until, reason: "rate limited (429)" },
      { relay: "https://relay.pkarr.org", state: "failing", until, reason: "no answer" },
    ] } } });
    const block = screen.getByTestId("connection-discovery");
    expect(screen.getByTestId("connection-details")).toContainElement(block);
    expect(screen.getByTestId("connection-discovery-path")).toHaveTextContent("DHT direct");
    const time = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(within(block).getAllByTestId("connection-relay").map(r => [r.dataset.state, r.textContent, r.title])).toEqual([
      ["ok", "pkarr.pubky.org ok", ""],
      ["throttled", `pkarr.pubky.app throttled until ${time}`, "rate limited (429)"],
      ["failing", `relay.pkarr.org failing until ${time}`, "no answer"],
    ]);
  });

  it("names the relay the last read went through on the web", () => {
    banner({ pairing: ready() }, { transport: { discovery: { path: { via: "relay", relay: "https://pkarr.pubky.app" }, relays: [{ relay: "https://pkarr.pubky.app", state: "ok" }] } } });
    expect(screen.getByTestId("connection-discovery-path")).toHaveTextContent("Relay: pkarr.pubky.app");
  });

  it("is not there when the app says nothing about discovery", () => {
    banner({ pairing: ready() });
    expect(screen.queryByTestId("connection-discovery")).toBeNull();
  });
});

// covers: app.clock-off
describe("the note that this device's clock seems to be off", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const RELAYS = ["https://pkarr.pubky.org"];
  const web = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };
  const live = linkView({ availableTransports: ["webrtc/1"], peerTransports: ["webrtc/1"], transportAutomatic: true, pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" });
  const waiting = linkView({ availableTransports: ["webrtc/1"], peerTransports: [], transportAutomatic: true });
  const HINT = "This device's clock seems to be off by about 2 minutes. Chats may be slow to connect.";

  it("is in the chat's connection panel while the engine says so, one short line with the story behind its ⓘ", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: { ...web, clockOffMs: 2 * 60_000 + 3_000 }, links: [live] }));
    await view.user.click(screen.getByTestId("connection-options"));
    const panel = screen.getByRole("dialog", { name: "Connection options" });
    const note = within(panel).getByTestId("connection-clock-off");
    expect(note).toHaveTextContent(HINT);
    // No alarm: a line among the others, and its story only when asked for.
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(within(note).queryByTestId("connection-clock-off-text")).toBeNull();
    const more = within(note).getByRole("button", { name: "More info" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await view.user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const story = within(note).getByTestId("connection-clock-off-text");
    expect(story).toHaveTextContent("about 2 minutes ahead of what the relays and your contacts' devices say");
    expect(story).toHaveTextContent("Set the date and time to automatic");
    expect(story).toHaveTextContent("never one contact alone");

    // Behind says so, and an hour reads as an hour.
    act(() => view.engine.update({ transport: { ...web, clockOffMs: -3 * 60 * 60_000 }, links: [live] }));
    expect(within(panel).getByTestId("connection-clock-off")).toHaveTextContent("off by about 3 hours");
    expect(within(panel).getByTestId("connection-clock-off-text")).toHaveTextContent("about 3 hours behind what the relays");

    // The clock agrees again: the note goes by itself.
    act(() => view.engine.update({ transport: web, links: [live] }));
    expect(screen.queryByTestId("connection-clock-off")).toBeNull();
  });

  it("is there for a chat that is not connected yet too: that is when it matters", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: { ...web, clockOffMs: -2 * 60_000 }, links: [waiting] }));
    await view.user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-clock-off")).toHaveTextContent(HINT);
  });

  it("is in Settings, Network too, with the same words", async () => {
    const view = renderApp(<NetworkSettings />);
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-clock-off")).toBeNull();
    act(() => view.engine.update({ transport: { ...web, clockOffMs: 2 * 60_000 }, settings: { relays: RELAYS } }));
    const row = screen.getByTestId("network-clock-off");
    expect(row).toHaveTextContent("Device clock");
    expect(row).toHaveTextContent(HINT);
    await view.user.click(within(row).getByTestId("row-info"));
    expect(within(row).getByTestId("row-info-text")).toHaveTextContent("about 2 minutes ahead");
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-clock-off")).toBeNull();
  });

  it("says the amount to the minute, never less than one, in hours past ninety minutes, in the app's language", () => {
    expect(clockOffAmount(61_000, "en")).toBe("1 minute");
    expect(clockOffAmount(-89 * 60_000, "en")).toBe("89 minutes");
    expect(clockOffAmount(90 * 60_000, "en")).toBe("2 hours");
    expect(clockOffAmount(2 * 60_000, "pt")).toBe("2 minutos");
    expect(clockOffAmount(2 * 60_000, "not a language")).toBe("2 minutes");
  });

  it("has its words in every language, each with the amount, and no em dash", () => {
    for (const [language, strings] of Object.entries(locales)) {
      const clock = (strings as { connection: { clockOff: Record<string, string> } }).connection.clockOff;
      expect(Object.keys(clock).sort(), language).toEqual(["hint", "infoAhead", "infoBehind", "title"]);
      for (const key of ["hint", "infoAhead", "infoBehind"]) {
        expect(clock[key], `${language} ${key}`).toContain("{{amount}}");
        expect(clock[key], `${language} ${key}`).not.toContain("—");
      }
      expect(clock.infoAhead, language).not.toBe(clock.infoBehind);
      expect(clock.hint.length, `${language}: one short line`).toBeLessThan(140);
    }
  });
});

// covers: transport.chat-switch
/**
 * DHT only closes the live link, and a call's hang-up crosses it: chosen during a call, the call talked on over its
 * own connection and neither side could hang it up (the contact's ended only when its media stalled out). So DHT only
 * is off while a call is on in that chat, with the reason on screen, and back once the call ends.
 */
describe("the connection panel's DHT only during a call", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
  const live = (patch: Partial<LinkView> = {}) => linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1",
    pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open", ...patch });
  const reason = "Hang up the call to use DHT only";

  it("is off with the reason while a call is on in the chat, and chooses nothing", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" callOn />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toBeDisabled();
    expect(dht).toHaveAccessibleDescription(reason);
    // On screen at every width, not only in a tooltip.
    expect(within(dht).getByText(reason)).not.toHaveClass("md:hidden");
    await user.click(dht);
    expect(engine.callsTo("setChatTransport")).toEqual([]);
    // The other choices stay.
    expect(screen.getByTestId("connection-option-iroh")).toBeEnabled();
    expect(screen.getByTestId("connection-option-auto")).toBeEnabled();
  });

  it("is on with no call, and comes back when the call ends", async () => {
    const { user, engine, rerender } = renderApp(<ChatConnection peerKey="peer" callOn />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-option-dht")).toBeDisabled();
    rerender(<ChatConnection peerKey="peer" callOn={false} />);
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toBeEnabled();
    expect(dht).not.toHaveAccessibleDescription(reason);
    await user.click(dht);
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
  });

  it("is on in a chat beside the one with the call", async () => {
    const { user, engine } = renderApp(<>
      <ChatConnection peerKey="peer" callOn />
      <ChatConnection peerKey="other" testIdPrefix="b-" />
    </>);
    act(() => engine.update({ links: [live(), live({ id: "link-2", peerPubKeyZ32: "other" })] }));
    await user.click(screen.getByTestId("b-connection-options"));
    const panel = screen.getByTestId("b-connection-menu");
    expect(within(panel).getByTestId("connection-option-dht")).toBeEnabled();
    await user.click(within(panel).getByTestId("connection-option-dht"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-2", transport: "dht" }]);
  });

  it("is skipped by the arrow keys, and a call coming in while it has the focus leaves the focus in the group", async () => {
    const { user, engine, rerender } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [live()] }));
    await user.click(screen.getByTestId("connection-options"));
    const dht = screen.getByTestId("connection-option-dht");
    dht.focus();
    rerender(<ChatConnection peerKey="peer" callOn />);
    expect(dht).toBeDisabled();
    // The group's Tab stop, the transport chosen, has it: never the page.
    const webrtc = screen.getByTestId("connection-option-webrtc");
    expect(webrtc).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByTestId("connection-option-hyperdht")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("connection-option-auto")).toHaveFocus();
  });
});

// covers: transport.chat-switch
/**
 * The panel disables its choices and buttons while the engine works on one, and a browser drops the focus of a
 * disabled control to the page: the next Tab left the panel, and its Escape did not close it. Once the work is done,
 * the focus is back on what was pressed.
 */
describe("the connection panel, while a choice or button works", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

  /**
   * What a real browser does to a focused control that turns disabled: the page gets the focus. happy-dom keeps it on
   * the control, and its `blur()` does nothing on a disabled one, so the control reads as enabled for that one call.
   */
  function dropFocusIfDisabled() {
    const el = document.activeElement as HTMLButtonElement | null;
    if (!el || !(el.disabled || el.closest("fieldset[disabled]"))) return;
    Object.defineProperty(el, "disabled", { value: false, configurable: true });
    el.blur();
    delete (el as Partial<HTMLButtonElement>).disabled;
  }

  /** An engine call held open until `done()`: the panel stays busy meanwhile. */
  function held(engine: ReturnType<typeof renderApp>["engine"], method: "setChatTransport" | "confirmPair", fail?: string) {
    let done!: () => void;
    engine.on(method, () => new Promise<void>((resolve, reject) => { done = () => fail ? reject(new Error(fail)) : resolve(); }));
    return () => act(async () => { done(); });
  }

  it("gives the focus back to the transport chosen from the keyboard", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1", pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    const finish = held(engine, "setChatTransport");
    await user.click(screen.getByTestId("connection-options"));
    screen.getByTestId("connection-option-webrtc").focus();
    await user.keyboard("{End}");
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toHaveFocus();
    await user.keyboard(" ");
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
    expect(dht).toBeDisabled();
    dropFocusIfDisabled();
    expect(document.body).toHaveFocus();
    await finish();
    expect(dht).not.toBeDisabled();
    expect(dht).toHaveFocus();
  });

  it("gives the focus back to The codes match when the engine refuses it", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, peerParticipationKey: "saved", pairing: { status: "ready", transport: "webrtc/1", code: "4821 0937", peerKey: "peer" } as Pairing })] }));
    const finish = held(engine, "confirmPair", "No authenticated peer to verify");
    await user.click(screen.getByTestId("connection-options"));
    await user.click(screen.getByTestId("pair-verify"));
    const confirm = screen.getByTestId("pair-verify-confirm");
    confirm.focus();
    await user.keyboard("{Enter}");
    // Off while it works, by aria-disabled: it keeps the focus, so there is nothing for Chromium to drop.
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    dropFocusIfDisabled();
    expect(confirm).toHaveFocus();
    await finish();
    expect(screen.getByTestId("pair-verify-error")).toBeInTheDocument();
    expect(confirm).toHaveFocus();
  });

  it("leaves the focus where the person moved it meanwhile", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1", pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    const finish = held(engine, "setChatTransport");
    await user.click(screen.getByTestId("connection-options"));
    screen.getByTestId("connection-option-dht").focus();
    await user.keyboard(" ");
    dropFocusIfDisabled();
    const details = screen.getByTestId("connection-details-summary");
    details.focus();
    await finish();
    expect(details).toHaveFocus();
  });
});

// covers: chat.paired.reconnect
/**
 * Reconnect is there only while the chat is not live. When the contact came back with the focus on it (just pressed,
 * or tabbed to), it went from under the focus, which fell to the page: a screen reader lost its place, and Tab started
 * again from the top. The panel's state line, which then says the chat is live, takes it instead.
 */
describe("the connection panel, when the chat goes live under Reconnect", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
  const away: Partial<LinkView> = { dataLink: "idle", peerOnline: false, peerParticipationKey: "saved" };
  const live: Partial<LinkView> = { dataLink: "open", peerOnline: true, peerParticipationKey: "saved", pairing: { status: "ready", transport: "webrtc/1", peerKey: "peer" } as Pairing };

  /** The chat with a contact who is away, its connection panel open. */
  async function openAway(outside = false) {
    const view = renderApp(<><ChatConnection peerKey="peer" />{outside && <button type="button">Elsewhere</button>}</>);
    act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...away })] }));
    await view.user.click(screen.getByTestId("connection-options"));
    return { ...view, goLive: () => act(() => view.engine.update({ links: [linkView({ availableTransports: all, ...live })] })) };
  }

  it("moves the focus from Reconnect to the state line, which says the chat is live", async () => {
    const { goLive } = await openAway();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    reconnect.focus();
    goLive();
    expect(reconnect).not.toBeInTheDocument();
    const state = screen.getByTestId("connection-state");
    expect(document.body).not.toHaveFocus();
    expect(state).toHaveFocus();
    expect(state).toHaveTextContent("Connected · WebRTC");
    expect(state).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the focus on Reconnect while it dials, then gives it to the state line once live", async () => {
    const { user, engine, goLive } = await openAway();
    let answer: () => void = () => {};
    engine.on("connect", () => new Promise<void>((resolve) => { answer = resolve; }));
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    await user.click(reconnect);
    expect(reconnect).toHaveTextContent("Reconnecting…");
    expect(reconnect).toHaveFocus();
    goLive();
    await act(async () => answer());
    expect(screen.getByTestId("connection-state")).toHaveFocus();
  });

  it("leaves the focus alone when it was elsewhere in the panel", async () => {
    const { goLive } = await openAway();
    const details = screen.getByTestId("connection-details-summary");
    details.focus();
    goLive();
    expect(details).toHaveFocus();
  });

  it("leaves the focus alone when it was outside the panel", async () => {
    const { goLive } = await openAway(true);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    goLive();
    expect(elsewhere).toHaveFocus();
  });

  it("still closes on Escape from the state line, handing the focus back to the header", async () => {
    const { user, goLive } = await openAway();
    const menu = screen.getByTestId("connection-menu") as HTMLDetailsElement;
    screen.getByRole("button", { name: "Reconnect" }).focus();
    goLive();
    expect(screen.getByTestId("connection-state")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(menu.open).toBe(false);
    expect(screen.getByTestId("connection-options")).toHaveFocus();
  });
});

// covers: transport.direct-blocked
describe("the note that direct connections are blocked on this network", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const RELAYS = ["https://pkarr.pubky.org"];
  const web = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };
  const relayed = linkView({ availableTransports: ["webrtc/1", "iroh/1"], peerTransports: ["webrtc/1", "iroh/1"], relayedTransports: ["iroh/1"], transportAutomatic: true,
    pairing: { status: "ready", transport: "iroh/1" } as Pairing, dataLink: "open", transportRelayed: { relays: ["relay.example"] } });
  const HINT = "Direct connections are blocked on this network (a VPN or firewall?). Chats still work through relays, but connect more slowly.";

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
    expect(story).toHaveTextContent("never what they say");
    expect(story).toHaveTextContent("This clears when a direct connection works");

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
    expect(within(row).getByTestId("row-info-text")).toHaveTextContent("Calls need a TURN server");
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-direct-blocked")).toBeNull();
  });
});

// covers: transport.wait, transport.indicator
describe("a chat that is not live", () => {
  describe("why a chat is not live (WISP 100)", () => {
    const text = (attempt: LiveAttempt | undefined, dialer?: "you" | "contact") => liveAttemptText(attempt, dialer, "Bea", () => "17:02");

    it("says what the dialling side tried, why each did not connect, and when it tries again", () => {
      expect(text({ at: 1, side: "dialled", retryAt: Date.now() + 60_000, failed: [
        { transport: "webrtc/1", error: "The offer was not answered" },
        { transport: "iroh/1", error: "The contact has no Iroh relay" },
      ] }, "you")).toEqual({ label: "Last attempt at 17:02", lines: [
        "WebRTC: The offer was not answered.", "Iroh: The contact has no Iroh relay.", "Trying again at about 17:02.",
      ] });
      // Nothing to try yet: why, instead of a list, in the app's words.
      expect(text({ at: 1, side: "dialled", failed: [], reason: "No transport both apps allow is available yet" }, "you")?.lines)
        .toEqual(["No way to connect in common."]);
    });

    it("drops a retry time that has passed: nothing dialled when it came", () => {
      expect(text({ at: 1, side: "dialled", retryAt: Date.now() - 60_000, failed: [{ transport: "hyperdht/1", error: "Couldn't connect" }] }, "contact")?.lines)
        .toEqual(["Bea's app connects to this one: this app answers.", "HyperDHT: Couldn't connect."]);
    });

    it("says on the answering side that the contact dials, and what of it reached this app", () => {
      expect(text({ at: 1, side: "answered", failed: [{ transport: "webrtc/1", error: "No connection came up" }] }, "contact")).toEqual({
        label: "Last attempt at 17:02", lines: ["Bea's app connects to this one: this app answers.", "Bea's last attempt reached this app and did not connect:", "WebRTC: No connection came up."],
      });
      expect(text(undefined, "contact")).toEqual({ label: "Not live yet", lines: ["Bea's app connects to this one: this app answers.", "No attempt of Bea's has reached this app yet."] });
    });

    it("says nothing on the dialling side before its first attempt", () => {
      expect(text(undefined, "you")).toBeUndefined();
      expect(text(undefined, undefined)).toBeUndefined();
    });
  });

  describe("the connection panel of a chat on the DHT", () => {
    const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved", peerNick: "Bea",
      pairing: { status: "connecting" } as LinkView["pairing"] };
    function panel(link: Partial<LinkView>) {
      const view = renderApp(<ChatConnection peerKey="peer" />);
      act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1", "iroh/1"], ...onDht, ...link })] }));
      return view;
    }

    it("says under Details why it is not live, from this side's last attempt", () => {
      panel({ liveDialer: "you", liveAttempt: { at: Date.UTC(2026, 8, 25, 19, 58), side: "dialled", retryAt: Date.now() + 60_000,
        failed: [{ transport: "webrtc/1", error: "The offer was not answered" }, { transport: "iroh/1", error: "The contact has no Iroh relay" }] } });
      expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: On DHT · retrying live");
      const block = screen.getByTestId("connection-not-live");
      expect(screen.getByTestId("connection-details")).toContainElement(block);
      expect(block).toHaveAttribute("data-side", "dialled");
      expect(block).toHaveTextContent(/^Last attempt at /);
      expect(block).toHaveTextContent("WebRTC: The offer was not answered.");
      expect(block).toHaveTextContent("Iroh: The contact has no Iroh relay.");
      expect(block).toHaveTextContent(/Trying again at about /);
    });

    it("says on the side that answers that its contact dials, before anything reached it", () => {
      panel({ liveDialer: "contact" });
      expect(screen.getByTestId("connection-not-live")).toHaveTextContent("Not live yetBea's app connects to this one: this app answers.No attempt of Bea's has reached this app yet.");
    });

    it("says nothing of it while live, or in DHT only", () => {
      const attempt: LiveAttempt = { at: 1, side: "dialled", failed: [{ transport: "iroh/1", error: "x" }] };
      const live = panel({ textDelivery: "stream", dataLink: "open", pairing: { status: "ready", transport: "iroh/1" } as LinkView["pairing"], liveDialer: "you", liveAttempt: attempt });
      expect(screen.queryByTestId("connection-not-live")).toBeNull();
      live.unmount();
      panel({ deliveryMode: "dht", liveDialer: "contact" });
      expect(screen.queryByTestId("connection-not-live")).toBeNull();
    });

    it("says nothing of it while the contact keeps the chat on DHT only: no attempt will come, the choice is said instead", () => {
      const attempt: LiveAttempt = { at: 1, side: "dialled", retryAt: Date.now() + 60_000, failed: [{ transport: "webrtc/1", error: "The offer was not answered" }] };
      const peerDht = { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } as const;
      const answering = panel({ liveDialer: "contact", dhtDelivery: peerDht });
      expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: DHT only · chosen by your contact");
      expect(screen.queryByTestId("connection-not-live")).toBeNull();
      expect(screen.getByTestId("connection-option-dht")).toHaveAttribute("aria-description", "Your contact chose it · no live link until you both leave it");
      answering.unmount();
      panel({ liveDialer: "you", liveAttempt: attempt, dhtDelivery: peerDht });
      expect(screen.queryByTestId("connection-not-live")).toBeNull();
    });
  });
});

// covers: transport.indicator, transport.iroh-web
describe("a chat back on Automatic over Iroh's relay, on its way to WebRTC", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  /** Two browsers on Automatic: both run WebRTC and Iroh, and a browser's Iroh always goes through its relay. */
  const web: Partial<LinkView> = {
    availableTransports: ["iroh/1", "webrtc/1"], peerTransports: ["iroh/1", "webrtc/1"], relayedTransports: ["iroh/1"], transportAutomatic: true,
  };
  const onDht = linkView({ ...web, dataLink: "idle", textDelivery: "dht", pairing: { status: "waiting" } as Pairing });
  const onIroh = linkView({ ...web, dataLink: "open", pairing: { status: "ready", transport: "iroh/1" } as Pairing, transportRelayed: { relays: ["127.0.0.1"] } });
  const onWebrtc = linkView({ ...web, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } as Pairing });

  /** What a screen reader is told: the header's polite live region, each time its words change. */
  function listen() {
    const said: string[] = [];
    const region = () => document.querySelector(".sr-only[aria-live=polite]");
    let last = region()?.textContent ?? "";
    const observer = new MutationObserver(() => { const now = region()?.textContent ?? ""; if (now !== last) { last = now; said.push(now); } });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return { said, stop: () => observer.disconnect() };
  }
  const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

  afterEach(() => { vi.useRealTimers(); });

  it("says only where it lands: not the relayed Iroh it moves off a moment later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [onDht] }));
    const ear = listen();
    // As measured between two browsers at a reload: live over the relay, then on WebRTC about 250 ms later.
    act(() => engine.update({ links: [onIroh] }));
    await act(async () => { vi.advanceTimersByTime(250); await flush(); });
    act(() => engine.update({ links: [onWebrtc] }));
    await act(async () => { vi.advanceTimersByTime(MOVE_QUIET_MS); await flush(); });
    ear.stop();
    expect(ear.said).toEqual(["Connected · WebRTC"]);
  });

  it("still says the relayed Iroh once the move has not come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [onDht] }));
    const ear = listen();
    act(() => engine.update({ links: [onIroh] }));
    await act(async () => { vi.advanceTimersByTime(MOVE_QUIET_MS); await flush(); });
    ear.stop();
    expect(ear.said).toEqual(["Connected · Iroh (relayed)"]);
  });

  it("says it at once where no move is due: Iroh chosen, or no direct transport both apps run", () => {
    for (const link of [linkView({ ...onIroh, transportAutomatic: false, preferredTransport: "iroh/1" }), linkView({ ...onIroh, availableTransports: ["iroh/1"] })]) {
      const { engine, unmount } = renderApp(<ChatConnection peerKey="peer" />);
      act(() => engine.update({ links: [onDht] }));
      act(() => engine.update({ links: [link] }));
      expect(document.querySelector(".sr-only[aria-live=polite]")).toHaveTextContent("Connected · Iroh (relayed)");
      unmount();
    }
  });

  it("says it at once on a network that blocks direct connections: no move to WebRTC comes there", () => {
    const { engine } = renderApp(<ChatConnection peerKey="peer" />);
    const transport = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: ["https://pkarr.pubky.org"], directBlocked: true as const };
    act(() => engine.update({ transport, links: [onDht] }));
    act(() => engine.update({ transport, links: [onIroh] }));
    expect(document.querySelector(".sr-only[aria-live=polite]")).toHaveTextContent("Connected · Iroh (relayed)");
  });
});

// covers: transport.relayed, transport.indicator, transport.chat-switch
describe("a relayed transport", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const onHyperdht = { status: "ready", transport: "hyperdht/1" } as Pairing;
  /** A browser whose HyperDHT goes through a relay, talking to a contact on WebRTC and HyperDHT. */
  const web: Partial<LinkView> = {
    availableTransports: ["webrtc/1", "hyperdht/1"], peerTransports: ["webrtc/1", "iroh/1", "hyperdht/1"], relayedTransports: ["hyperdht/1"], transportAutomatic: true,
  };

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
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-relayed", "");
    expect(screen.getByTestId("connection-options")).toHaveAccessibleName("Connection options: Connected · HyperDHT (relayed)");
    await view.user.click(screen.getByTestId("connection-options"));
    const panel = screen.getByRole("dialog", { name: "Connection options" });
    expect(within(panel).getByTestId("connection-option-hyperdht")).toHaveTextContent("In use · relayed · 180 ms");
    expect(within(panel).getByTestId("connection-relayed")).toHaveTextContent("Relayed via relay.example");
    expect(within(panel).getByTestId("connection-summary")).toHaveTextContent("never what they say");
  });

  it("when not in use, says it goes through a relay", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ links: [linkView({ ...web, pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    await view.user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-option-hyperdht")).toHaveAttribute("title", "HyperDHT: Through a relay · used when nothing direct connects");
  });
});

// covers: transport.chat-switch
/**
 * The connection choices were a radiogroup that arrow keys did not move in, each radio its own Tab stop. Now they are
 * one Tab stop (the checked choice), and the arrows move between the choices that can be made.
 */
describe("the connection choices, by keyboard", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

  async function open(link: Partial<LinkView>, language?: "ar") {
    const view = renderApp(<ChatConnection peerKey="peer" />, language ? { language } : undefined);
    act(() => view.engine.update({ links: [linkView({ pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open", ...link })] }));
    view.engine.on("setChatTransport", () => undefined);
    await view.user.click(screen.getByTestId("connection-options"));
    const group = screen.getByTestId("transport-options");
    const radio = (id: string) => within(group).getByTestId(`connection-option-${id}`);
    const focused = () => document.activeElement?.getAttribute("data-testid")?.replace("connection-option-", "");
    return { ...view, group, radio, focused };
  }

  it("are one Tab stop, the checked choice, and the arrows move past what is off, around the ends", async () => {
    // Iroh chosen; HyperDHT off (the contact's app lacks it).
    const { user, radio, focused, engine } = await open({ availableTransports: all, peerTransports: ["webrtc/1", "iroh/1"], preferredTransport: "iroh/1", transportAutomatic: false });
    expect(["auto", "webrtc", "iroh", "hyperdht", "dht"].map(id => radio(id).tabIndex)).toEqual([-1, -1, 0, -1, -1]);

    radio("iroh").focus();
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("dht"); // HyperDHT is off: skipped
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("auto"); // around the end
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe("dht");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("auto");
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe("dht");
    await user.keyboard("{Home}");
    expect(focused()).toBe("auto");
    await user.keyboard("{End}");
    expect(focused()).toBe("dht");
    // Moving chooses nothing: the live session moves only when a choice is made.
    expect(engine.callsTo("setChatTransport")).toEqual([]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(focused()).toBe("webrtc");
    await user.keyboard(" ");
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "webrtc/1" }]);
  });

  it("with nothing checked that can be chosen, the first choice that can is the Tab stop", async () => {
    // HyperDHT chosen, but off here: the first enabled choice takes the Tab stop.
    const { radio } = await open({ availableTransports: ["webrtc/1", "iroh/1"], preferredTransport: "hyperdht/1", transportAutomatic: false });
    expect(["auto", "webrtc", "iroh", "hyperdht", "dht"].map(id => radio(id).tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it("in Arabic, Left goes on and Right goes back, as the page reads", async () => {
    const { user, group, radio, focused } = await open({ availableTransports: all, transportAutomatic: true }, "ar");
    group.style.direction = "rtl";
    radio("auto").focus();
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe("webrtc");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("auto");
  });

  it("leaving DHT only by Automatic, with Iroh out of reach, keeps the focus in the group when the Automatic row goes", async () => {
    // On the web on DHT only, the choices are what this app can run (WebRTC and Iroh); off DHT only, what it runs
    // now: WebRTC alone, as Iroh cannot start. Automatic then is the only choice and its row goes from under the focus.
    const dhtOnly = { availableTransports: ["webrtc/1"], runnableTransports: ["webrtc/1", "iroh/1"], transportAutomatic: true } as Partial<LinkView>;
    const { user, radio, engine } = await open({ ...dhtOnly, deliveryMode: "dht" });
    await user.click(radio("auto"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "auto" }]);
    act(() => engine.update({ links: [linkView({ pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open", ...dhtOnly, deliveryMode: "stream" })] }));
    expect(screen.queryByTestId("connection-option-auto")).toBeNull();
    // The group's Tab stop, WebRTC (now checked), has it: never the page.
    expect(radio("webrtc")).toHaveFocus();
    expect(radio("webrtc")).toHaveAttribute("aria-checked", "true");
  });

  it("show the keyboard focus with the accent ring, not only a background a shade off the dialog's", async () => {
    const { radio } = await open({ availableTransports: all, transportAutomatic: true });
    for (const id of ["auto", "webrtc", "iroh", "hyperdht", "dht"])
      expect(radio(id).className.split(/\s+/)).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-accent"]));
  });
});

// covers: transport.wait, transport.indicator
/** A contact who shared no name: the Details text says "your contact" in whole sentences, never the fallback name. */
describe("the connection Details of a contact with no name", () => {
  type Pairing = NonNullable<LinkView["pairing"]>;
  type Wait = NonNullable<LinkView["transportWait"]>;

  const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved",
    pairing: { status: "connecting" } as Pairing };
  function panel(link: Partial<LinkView>, language?: Language) {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language });
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1", "iroh/1"], ...onDht, ...link })] }));
    return view;
  }
  const lines = (testId: string) => [...screen.getByTestId(testId).querySelectorAll("p")].map(p => p.textContent);

  it.each<[Language, string[]]>([
    ["en", ["Not live yet", "Your contact's app connects to this one: this app answers.", "No attempt from your contact has reached this app yet."]],
    ["pt", ["Ainda sem conexão direta", "O app do seu contato conecta a este: este app responde.", "Nenhuma tentativa do seu contato chegou a este app ainda."]],
    ["zh", ["尚未直连", "你的联系人的应用会连接到本应用：本应用负责应答。", "你的联系人的连接尝试尚未到达本应用。"]],
  ])("says in %s why it is not live in whole sentences", (language, expected) => {
    panel({ liveDialer: "contact" }, language);
    expect(lines("connection-not-live")).toEqual(expected);
  });

  it("says what of the contact's attempt reached this app, and what the chat waits for", () => {
    panel({ liveDialer: "contact", liveAttempt: { at: 1, side: "answered", failed: [{ transport: "webrtc/1", error: "No connection came up" }] },
      transportWait: { transport: "iroh/1", by: "contact", reason: "starting", failures: 0 } as Wait }, "pt");
    expect(lines("connection-not-live").slice(1, 3)).toEqual(["O app do seu contato conecta a este: este app responde.",
      "A última tentativa do seu contato chegou a este app e não conectou:"]);
    expect(within(screen.getByTestId("connection-waiting")).getByTestId("connection-waiting-why"))
      .toHaveTextContent("Seu contato escolheu Iroh. O Iroh do seu contato está iniciando.");
  });

  // Every line the Details box can say with the contact in it, in every language. The fallback ("Your contact", "Il
  // tuo contatto") only ever opens a sentence where a name would; in Chinese and Japanese no space sits beside it (the
  // space a Latin name gets; the " · " between a line's parts aside); and nothing of "{{contact}}" or an "undefined" is left.
  const events: TransportEvent[] = [
    { at: 1, kind: "down", from: "webrtc/1", text: "hold" },
    { at: 1, kind: "switched", from: "webrtc/1", transport: "iroh/1", cause: "contact" },
    { at: 1, kind: "chose", cause: "contact", target: "iroh/1" },
    { at: 1, kind: "chose", cause: "contact" },
    { at: 1, kind: "dht-only", cause: "contact" },
  ];
  const waits: Wait[] = (["unknown", "starting", "waiting", "contact-lacks"] as const).map(reason => ({ transport: "iroh/1", by: "contact", reason, failures: 0 }));
  it.each(LANGUAGES)("never drops the fallback name into a sentence in %s", (language) => {
    const t = translateWith(LOCALES[language], language), fallback = t("pairing.contact");
    panel({ liveDialer: "contact", liveAttempt: { at: 1, side: "answered", failed: [] }, transportWait: waits[1], transportHistory: events }, language);
    const said = [
      ...lines("connection-not-live"), ...lines("connection-waiting"),
      ...screen.getAllByTestId("connection-history-event").map(e => e.querySelector("span")!.textContent!),
      ...liveAttemptText(undefined, "contact", undefined, () => "17:02", t)!.lines,
      ...waits.map(w => transportWaitText(w, undefined, () => "17:02", t).why),
      ...events.map(e => transportEventText(e, undefined, t)),
    ];
    expect(said.length).toBeGreaterThan(15);
    const cjk = language === "zh" || language === "ja";
    for (const line of said) {
      expect([language, line]).not.toEqual([language, expect.stringMatching(/\{\{|\}\}|undefined/)]);
      if (cjk) expect([language, line]).not.toEqual([language, expect.stringMatching(new RegExp(`${fallback} |(?<!·) ${fallback}`))]);
      else if (language !== "ar") expect([language, line, "mid-sentence", line!.indexOf(fallback) > 0]).toEqual([language, line, "mid-sentence", false]);
    }
  });

  it("keeps the contact's name when there is one", () => {
    panel({ liveDialer: "contact", peerNick: "Bea" });
    expect(lines("connection-not-live").slice(1)).toEqual(["Bea's app connects to this one: this app answers.", "No attempt of Bea's has reached this app yet."]);
  });
});
