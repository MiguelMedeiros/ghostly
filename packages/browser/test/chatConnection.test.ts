import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ChatConnection } from "../../../src/components/ChatConnection";
// covers: chat.paired.status, chat.paired.verify, invite.discovery-errors

const { client } = vi.hoisted(() => ({ client: { state: { settings: { online: true }, links: [] as unknown[] } } }));
vi.mock("@ghostly/browser/platform/engine", () => ({ engine: client }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

it.each([false, true])("does not label a mismatched connection trusted (previously verified: %s)", verified => {
  client.state.links = [{ id: "chat", peerPubKeyZ32: "peer", peerParticipationKey: "saved", peerVerified: verified,
    pairing: { status: "error", peerKey: "replacement", keyMismatch: true, error: "Different participation key" } }];
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ChatConnection, { peerKey: "peer" })));
  expect(html).toContain("does not match the saved contact");
  expect(html).not.toContain("pinned and unchanged");
  expect(html).not.toContain("Authenticated and pinned on first use");
  expect(html).not.toContain('data-testid="pair-verified"');
  expect(html).not.toContain('data-testid="pair-verify"');
});

it("shows a new chat waiting without a spinner, and keeps real discovery errors visible", () => {
  const link = { id: "chat", peerPubKeyZ32: "peer", dataLink: "idle", peerOnline: false,
    availableTransports: ["webrtc/1", "iroh/1", "hyperdht/1"], pairing: { status: "connecting" }, discoveryError: undefined as string | undefined };
  client.state.links = [link];
  const render = () => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ChatConnection, { peerKey: "peer" })));
  expect(render()).toContain("No contact yet");
  expect(render()).not.toContain("animate-pulse");
  link.discoveryError = "Could not publish discovery: fixture unavailable";
  expect(render()).toContain("Publication unavailable");
  expect(render()).not.toContain("Connection issue");
  expect(render()).toContain(link.discoveryError);
  expect(render()).not.toContain('type="radio" disabled');
});

const header = (html: string) => {
  const summary = /<summary([^>]*)>([\s\S]*?)<\/summary>/.exec(html)!;
  const tooltip = /<span role="tooltip"[^>]*>([\s\S]*?)<\/span><span class="sr-only"/.exec(html)!;
  return { attributes: summary[1], text: summary[2].replace(/<[^>]*>/g, ""), pulse: summary[2].includes("animate-pulse"),
    state: /data-state="(\w+)"/.exec(summary[1])?.[1], tooltip: tooltip[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() };
};

it.each([
  // Live, the tooltip adds what the connection is (#204): here only why, since nothing was measured.
  ["connected", { status: "ready", transport: "iroh/1" }, { dataLink: "open" }, "Connected · Iroh", false, " automatic"],
  ["waiting", { status: "connecting", peerKey: "peer" }, { dataLink: "connecting", peerOnline: true }, "Connecting…", true],
  ["waiting", { status: "ready", transport: "webrtc/1", transitionTarget: "iroh/1" }, { dataLink: "open" }, "Switching · Iroh", true, " automatic"],
  ["waiting", { status: "waiting", peerKey: "peer" }, { dataLink: "idle", peerParticipationKey: "saved" }, "Waiting for contact", false],
  ["dht", { status: "ready", transport: "webrtc/1" }, { dataLink: "open", textDelivery: "dht" }, "On DHT · retrying live", false],
  ["dht", { status: "connecting" }, { dataLink: "idle", deliveryMode: "dht" }, "DHT only · chosen by you", false],
  ["failure", { status: "error", peerKey: "peer", error: "Relay refused" }, { dataLink: "idle" }, "Connection issue Relay refused", false],
] as const)("the header shows the %s state beside the key (%#)", (state, pairing, extra, tooltip, pulse, detail = "") => {
  client.state.settings.online = true;
  client.state.links = [{ id: "chat", peerPubKeyZ32: "peer", availableTransports: ["webrtc/1", "iroh/1"], pairing, ...extra }];
  const view = header(renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ChatConnection, { peerKey: "peer" }))));
  // The key, then the transport in use, or the state.
  expect(view.text).toBe(`peer·${state === "connected" ? "Iroh" : tooltip.replace(" Relay refused", "")}`);
  expect(view.state).toBe(state);
  expect(view.pulse).toBe(pulse);
  expect(view.tooltip).toBe(tooltip + detail);
  expect(view.attributes).toContain(`aria-label="Connection options: ${tooltip.replace(" Relay refused", "")}"`);
  expect(view.attributes).toMatch(/aria-describedby="[^"]+-tip"/);
});

it("says Offline, with its own icon, when Ghostly is set offline", () => {
  client.state.settings.online = false;
  client.state.links = [{ id: "chat", peerPubKeyZ32: "peer", dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } }];
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ChatConnection, { peerKey: "peer" })));
  const view = header(html);
  expect([view.text, view.state, view.tooltip]).toEqual(["peer·Offline", "offline", "Offline"]);
  expect(html).toContain('<span class="sr-only" aria-live="polite">Offline</span>');
  client.state.settings.online = true;
});
