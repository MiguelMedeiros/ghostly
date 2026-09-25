import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { TransportLine } from "../../components/TransportTimeline";
import { TransportChip, TransportMenu } from "../../components/TransportMenu";
import { mergeTimeline, shortReason, transportLineText, transportOptions, type TransportEntry } from "../../lib/transportEvents";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.timeline, transport.chat-switch

const line = (patch: Partial<TransportEntry>): TransportEntry => ({ id: "l1", at: Date.UTC(2026, 8, 25, 14, 2), kind: "connected", transport: "webrtc/1", ...patch });
type Pairing = NonNullable<LinkView["pairing"]>;
const ready = (patch: Partial<Pairing> = {}): Pairing => ({ status: "ready", transport: "webrtc/1", ...patch } as Pairing);

describe("transport lines: what each change reads as", () => {
  it.each<[string, Partial<TransportEntry>, string]>([
    ["the first connection", {}, "Connected over WebRTC"],
    ["live again after DHT only", { kind: "back", transport: "iroh/1" }, "Back live over Iroh"],
    ["back after an outage", { kind: "back", transport: "hyperdht/1", downMs: 6 * 60_000 }, "Reconnected over HyperDHT after 6 min"],
    ["back after an outage, on another transport", { kind: "back", transport: "iroh/1", from: "webrtc/1", downMs: 3 * 60 * 60_000 }, "Reconnected over Iroh after 3 h · WebRTC dropped"],
    ["your choice", { kind: "chose", cause: "you", target: "iroh/1", transport: "webrtc/1" }, "You chose Iroh"],
    ["the contact's choice", { kind: "chose", cause: "contact", target: "hyperdht/1", transport: undefined }, "Ana chose HyperDHT"],
    ["back to automatic", { kind: "chose", cause: "you", transport: "webrtc/1" }, "Back to automatic"],
    ["back to automatic, and the apps moved", { kind: "chose", cause: "you", from: "iroh/1", transport: "webrtc/1" }, "Back to automatic · now on WebRTC"],
    ["the contact back to automatic", { kind: "chose", cause: "contact", transport: "webrtc/1" }, "Ana went back to automatic"],
    ["your switch", { kind: "switched", cause: "you", from: "webrtc/1", transport: "hyperdht/1" }, "You switched to HyperDHT"],
    ["the contact's switch", { kind: "switched", cause: "contact", from: "webrtc/1", transport: "iroh/1" }, "Ana switched to Iroh"],
    ["a fallback after a drop", { kind: "switched", cause: "dropped", from: "webrtc/1", transport: "iroh/1" }, "Switched to Iroh: WebRTC dropped"],
    ["an upgrade by the apps", { kind: "switched", cause: "automatic", from: "webrtc/1", transport: "iroh/1" }, "Moved to Iroh, a direct path was found"],
    ["a move back to WebRTC by the apps", { kind: "switched", cause: "automatic", from: "iroh/1", transport: "webrtc/1" }, "Moved to WebRTC"],
    ["a failed switch", { kind: "failed", target: "iroh/1", transport: "webrtc/1", reason: "Transport change failed: iroh/1 did not connect in time. Retry or choose another transport." },
      "Couldn't switch to Iroh: Iroh did not connect in time. Still on WebRTC"],
    ["a failed switch with no reason and no live link", { kind: "failed", target: "hyperdht/1", transport: undefined }, "Couldn't switch to HyperDHT."],
    ["a lost link", { kind: "lost", transport: undefined, from: "webrtc/1" }, "Live connection lost"],
    ["a lost link, texts over the DHT", { kind: "lost", transport: undefined, from: "webrtc/1", fallback: "dht" }, "Live connection lost · texts go through the DHT"],
    ["a lost link, messages held", { kind: "lost", transport: undefined, from: "webrtc/1", fallback: "hold" }, "Live connection lost · messages wait for Ana"],
    ["DHT only, your choice", { kind: "dht-only", transport: undefined, cause: "you" }, "You switched to DHT only"],
    ["DHT only, the contact's choice", { kind: "dht-only", transport: undefined, cause: "contact" }, "Ana switched to DHT only"],
    ["out of DHT only", { kind: "dht-left", transport: undefined }, "Left DHT only · connecting live"],
    ["out of DHT only, a transport chosen", { kind: "dht-left", transport: "iroh/1" }, "Left DHT only · connecting live"],
    ["flapping, live", { kind: "flapping", count: 3, live: true, since: 0, at: 55_000 }, "Reconnected 3 times in 1 min · on WebRTC"],
    ["flapping, down", { kind: "flapping", count: 1, live: false, transport: undefined, since: 0, at: 5 * 60_000 }, "Reconnected 1 time in 5 min · not live now"],
  ])("%s", (_, patch, text) => {
    expect(transportLineText(line(patch), "Ana")).toBe(text);
  });

  it("keeps engine advice out of the line, and names transports", () => {
    expect(shortReason("Your contact did not acknowledge the transport change. Retry when both peers are connected.")).toBe("Your contact did not acknowledge the transport change");
    expect(shortReason("Transport change timed out. Your previous connection is kept when available; retry or choose another transport.")).toBe("Transport change timed out");
    expect(shortReason("hyperdht/1 unreachable")).toBe("HyperDHT unreachable");
  });

  it("shows the details on tap: transport, since when, why, round trip", async () => {
    const { user } = renderApp(<TransportLine entry={line({ kind: "switched", cause: "contact", from: "webrtc/1", transport: "iroh/1", rttMs: 38 })} contact="Ana" />);
    const row = screen.getByTestId("transport-line");
    expect(row.dataset.kind).toBe("switched");
    expect(screen.queryByTestId("transport-line-details")).toBeNull();
    const button = within(row).getByRole("button", { name: /Ana switched to Iroh/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("transport-line-details");
    expect(within(details).getByText("Transport").nextSibling).toHaveTextContent("Iroh");
    expect(within(details).getByText("Why").nextSibling).toHaveTextContent("Ana chose Iroh for this chat. The session moved from WebRTC without reconnecting.");
    expect(within(details).getByText("Round trip").nextSibling).toHaveTextContent("38 ms");
    expect(within(details).getByText("Since")).toBeInTheDocument();
    await user.click(button);
    expect(screen.queryByTestId("transport-line-details")).toBeNull();
  });

  it("says how long an outage lasted and what carried text meanwhile", async () => {
    const { user } = renderApp(<TransportLine entry={line({ kind: "back", transport: "iroh/1", from: "webrtc/1", downMs: 6 * 60_000, fallback: "dht" })} contact="Ana" />);
    await user.click(screen.getByRole("button"));
    const details = screen.getByTestId("transport-line-details");
    expect(within(details).getByText("Not live for").nextSibling).toHaveTextContent("6 min");
    expect(within(details).getByText("Why").nextSibling).toHaveTextContent(/^The live connection over WebRTC ended at .+ and was down for 6 min\. Texts went through the DHT meanwhile\. It came back over Iroh\.$/);
  });

  it("stands for the rows before it, and lists them in its details", async () => {
    const earlier = [line({ id: "e1", at: Date.UTC(2026, 8, 25, 14, 0) }), line({ id: "e2", kind: "dht-only", cause: "you", transport: undefined })];
    const { user } = renderApp(<TransportLine entry={line({ id: "l3", kind: "back", transport: "webrtc/1" })} earlier={earlier} contact="Ana" />);
    expect(screen.getByTestId("transport-line-earlier-count")).toHaveTextContent("+2");
    await user.click(screen.getByRole("button", { name: /Back live over WebRTC and 2 earlier changes/ }));
    expect(within(screen.getByTestId("transport-line-details")).getByText("Before this").nextSibling).toHaveTextContent("…and 2 more changes");
    expect(within(screen.getByTestId("transport-line-earlier")).getAllByRole("listitem").map(li => li.querySelector("span")!.textContent))
      .toEqual(["You switched to DHT only", "Connected over WebRTC"]);
  });

  it("gives no round trip for a link that is not live", async () => {
    const { user } = renderApp(<TransportLine entry={line({ kind: "lost", transport: undefined, from: "iroh/1", rttMs: 40 })} contact="Ana" />);
    await user.click(screen.getByRole("button"));
    const details = screen.getByTestId("transport-line-details");
    expect(within(details).getByText("Transport").nextSibling).toHaveTextContent("None live");
    expect(within(details).queryByText("Round trip")).toBeNull();
  });
});

describe("transport lines in the timeline", () => {
  it("go between the messages by time, and a flapping line stays where it began", () => {
    const messages = [{ id: "m1", timestamp: 10 }, { id: "m2", timestamp: 20 }, { id: "m3", timestamp: 30 }];
    const rows = mergeTimeline(messages, [
      line({ id: "a", at: 5 }), line({ id: "b", kind: "flapping", since: 15, at: 40, count: 2, live: true }), line({ id: "c", kind: "back", at: 35 }),
    ]);
    expect(rows.map(r => r.kind === "message" ? r.message.id : r.entry.id)).toEqual(["a", "m1", "b", "m2", "m3", "c"]);
    expect(mergeTimeline(messages, []).map(r => r.kind)).toEqual(["message", "message", "message"]);
  });

  it("merge rows with no message between them into the latest, never a column of them", () => {
    const messages = [{ id: "m1", timestamp: 10 }, { id: "m2", timestamp: 50 }];
    const rows = mergeTimeline(messages, [
      line({ id: "a", at: 5 }), line({ id: "b", at: 20 }), line({ id: "c", at: 30 }), line({ id: "d", at: 40 }), line({ id: "e", at: 60 }),
    ]);
    expect(rows.map(r => r.kind === "message" ? r.message.id : `${r.entry.id}+${r.earlier.map(e => e.id).join("")}`))
      .toEqual(["a+", "m1", "d+bc", "m2", "e+"]);
  });
});

describe("the chat's Connection menu", () => {
  const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

  function chip(link: Partial<LinkView>) {
    const view = renderApp(<TransportChip peerKey="peer" />);
    act(() => view.engine.update({ links: [linkView({ pairing: ready(), dataLink: "open", ...link })] }));
    return view;
  }

  it("offers only what both apps support, and says why the rest is off", () => {
    expect(transportOptions({ availableTransports: all, peerTransports: ["webrtc/1", "iroh/1"] })).toEqual([
      { transport: "webrtc/1", available: true },
      { transport: "iroh/1", available: true },
      { transport: "hyperdht/1", available: false, reason: "Your contact's app doesn't support HyperDHT" },
    ]);
    expect(transportOptions({ availableTransports: ["webrtc/1"], peerTransports: undefined }).filter(o => !o.available).map(o => o.reason))
      .toEqual(["Iroh needs Ghostly Desktop", "HyperDHT needs Ghostly Desktop"]);
    // A native adapter that could not start says so; Linux WebKitGTK has no WebRTC.
    expect(transportOptions({ availableTransports: ["hyperdht/1"], transportErrors: { "iroh/1": "All eight native connection slots are in use." } }).map(o => o.reason))
      .toEqual(["This app has no WebRTC", "All eight native connection slots are in use.", undefined]);
  });

  it("shows the live transport and its round trip in the header, and nothing until live", () => {
    const view = chip({ pairing: ready({ transport: "iroh/1" }), transportRttMs: 38 });
    const button = screen.getByTestId("transport-chip");
    expect(button).toHaveTextContent("Iroh· 38 ms");
    expect(button).toHaveAccessibleName("Connection: Iroh, round trip 38 ms. Change");
    act(() => view.engine.update({ links: [linkView({ pairing: ready({ transport: "iroh/1", transitionTarget: "hyperdht/1" }), dataLink: "open" })] }));
    expect(screen.getByTestId("transport-chip")).toHaveTextContent("Switching to HyperDHT");
    act(() => view.engine.update({ links: [linkView({ pairing: { status: "connecting" } as Pairing, dataLink: "idle" })] }));
    expect(screen.queryByTestId("transport-chip")).toBeNull();
  });

  it("switches this chat on Desktop, back to Automatic too, and keeps what the contact cannot use off", async () => {
    const { user, engine } = chip({ availableTransports: all, peerTransports: ["webrtc/1", "iroh/1"], transportAutomatic: true, transportRttMs: 12 });
    engine.on("setChatTransport", () => undefined);
    await user.click(screen.getByTestId("transport-chip"));
    const menu = screen.getByTestId("transport-menu");
    expect(within(menu).getByTestId("transport-menu-now")).toHaveTextContent("Connection · on WebRTC, 12 ms");
    const radios = within(menu).getAllByRole("radio");
    expect(radios.map(r => [r.textContent, r.getAttribute("aria-checked"), (r as HTMLButtonElement).disabled])).toEqual([
      ["AutomaticThe apps choose, WebRTC first", "true", false],
      ["WebRTCIn use · 12 ms", "false", false],
      ["Iroh", "false", false],
      ["HyperDHTYour contact's app doesn't support HyperDHT", "false", true],
      ["DHT onlyShort texts over the DHT, even offline", "false", false],
    ]);
    await user.click(within(menu).getByTestId("transport-option-iroh"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "iroh/1" }]);
    expect(screen.queryByTestId("transport-menu")).toBeNull();

    act(() => engine.update({ links: [linkView({ pairing: ready({ transport: "iroh/1" }), dataLink: "open", availableTransports: all, peerTransports: ["webrtc/1", "iroh/1"], preferredTransport: "iroh/1", transportAutomatic: false })] }));
    await user.click(screen.getByTestId("transport-chip"));
    expect(screen.getByTestId("transport-option-iroh")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("transport-option-auto")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("transport-option-auto"));
    expect(engine.callsTo("setChatTransport").slice(-1)[0]).toEqual({ linkId: "link-1", transport: "auto" });
  });

  it("says why a change could not be made, and stays open", async () => {
    const { user, engine } = chip({ availableTransports: all, transportAutomatic: true });
    engine.on("setChatTransport", () => { throw new Error("Transport unavailable"); });
    await user.click(screen.getByTestId("transport-chip"));
    await user.click(screen.getByTestId("transport-option-hyperdht"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transport unavailable");
    expect(screen.getByTestId("transport-menu")).toBeInTheDocument();
  });

  it("on the web shows WebRTC and DHT only, with a note: WebRTC is in use and nothing else is asked", async () => {
    const { user, engine } = chip({ availableTransports: ["webrtc/1"], transportAutomatic: true });
    engine.on("setChatTransport", () => undefined);
    await user.click(screen.getByTestId("transport-chip"));
    const menu = screen.getByTestId("transport-menu");
    const radios = within(menu).getAllByRole("radio");
    expect(radios.map(r => r.getAttribute("aria-label"))).toEqual(["WebRTC", "DHT only"]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toBeDisabled();
    expect(within(menu).getByTestId("transport-menu-note")).toHaveTextContent("This app connects over WebRTC only. Iroh and HyperDHT need Ghostly Desktop on both sides.");
    // DHT only is always there, on every app.
    await user.click(within(menu).getByTestId("transport-option-dht"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
  });

  it("on DHT only in a web app, WebRTC leaves it for the app's rule", async () => {
    const anchor = { current: document.body };
    const { user, engine } = renderApp(<TransportMenu link={linkView({ availableTransports: ["webrtc/1"], deliveryMode: "dht", dataLink: "idle", transportAutomatic: true })} open onClose={() => {}} anchorRef={anchor} />);
    engine.on("setChatTransport", () => undefined);
    expect(screen.getByTestId("transport-option-dht")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("transport-option-webrtc")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("transport-option-webrtc"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "auto" }]);
  });

  it("with DHT only on (reached from ⋮, no chip then), offers every way back to a live connection", async () => {
    const anchor = { current: document.body };
    const { user, engine } = renderApp(<TransportMenu link={linkView({ availableTransports: all, deliveryMode: "dht", dataLink: "idle", transportAutomatic: true })} open onClose={() => {}} anchorRef={anchor} />);
    engine.on("setChatTransport", () => undefined);
    const menu = screen.getByTestId("transport-menu");
    expect(within(menu).getByTestId("transport-menu-now")).toHaveTextContent("Connection · DHT only");
    expect(within(menu).getAllByRole("radio").filter(r => r.getAttribute("aria-checked") === "true").map(r => r.getAttribute("aria-label"))).toEqual(["DHT only"]);
    expect(within(menu).getAllByRole("radio").every(r => !(r as HTMLButtonElement).disabled)).toBe(true);
    await user.click(within(menu).getByTestId("transport-option-iroh"));
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "iroh/1" }]);
  });

  it("says when the contact chose DHT only", () => {
    const anchor = { current: document.body };
    renderApp(<TransportMenu link={linkView({ availableTransports: all, dataLink: "idle", transportAutomatic: true, dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } })} open onClose={() => {}} anchorRef={anchor} />);
    expect(screen.getByTestId("transport-option-dht")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("transport-option-dht")).toHaveAttribute("title", "DHT only: Your contact chose it · no live link until you both leave it");
    expect(screen.getByTestId("transport-menu-note")).toHaveTextContent("Your contact chose DHT only: no live connection until you both leave it.");
  });
});
