import { MemoryRouter } from "react-router-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PairingBanner } from "../../../src/components/PairingBanner";

const { client } = vi.hoisted(() => ({ client: { state: { settings: { online: true }, links: [] as unknown[] } } }));
vi.mock("@ghostly/browser/platform/engine", () => ({ engine: client }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

it.each([false, true])("does not label a mismatched connection trusted (previously verified: %s)", verified => {
  client.state.links = [{ id: "chat", peerPubKeyZ32: "peer", peerParticipationKey: "saved", peerVerified: verified,
    pairing: { status: "error", peerKey: "replacement", keyMismatch: true, error: "Different participation key" } }];
  const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(PairingBanner, { peerKey: "peer" })));
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
  const render = () => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(PairingBanner, { peerKey: "peer" })));
  expect(render()).toContain("No contact yet");
  expect(render()).not.toContain("animate-pulse");
  link.discoveryError = "Could not publish discovery: fixture unavailable";
  expect(render()).toContain("Publication unavailable");
  expect(render()).not.toContain("Connection issue");
  expect(render()).toContain(link.discoveryError);
  expect(render()).not.toContain('type="radio" disabled');
});
