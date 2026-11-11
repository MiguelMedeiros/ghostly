import { describe, expect, it, vi } from "vitest";

// covers: services.desktop-viewer

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => unknown>());
// One module stands for @tauri-apps/api/core and /event (`tauriAliases`): `listen` is here too.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async (name: string, handler: (event: { payload: unknown }) => unknown) => {
    listeners.set(name, handler);
    return () => {};
  },
  getIdentifier: async () => "app.ghostly.chat",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { invoke } from "@tauri-apps/api/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { LinkView } from "@ghostly/browser/shared/types";
import { createDesktopHost, type ServiceRequest, type ServiceWindowResponse } from "../../desktop/host";

/*
 * A Desktop viewer window shows a contact's app. When the contact takes it back, their machine answers for it
 * (`x-ghostly-error: unknown-service`) and the window says so, naming the app: by the name the contact gave it, not its
 * id, though by then the chat no longer lists it.
 */

type Host = {
  openService(peer: string, service: string, tag: string, relayOnly?: boolean): Promise<void>;
  onServer(server: unknown): void;
};
const called = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>>;
const PEER = "a".repeat(52);
const TAG = "ybndrfg8ejkmcpqx";
const page = (response: ServiceWindowResponse) => new TextDecoder().decode(Uint8Array.from(atob(response.body_b64), (c) => c.charCodeAt(0)));

describe("a Desktop viewer window whose app the contact took back", () => {
  it("names the app as the contact named it, not by its id", async () => {
    let shared: { id: string; name: string }[] = [{ id: "atlas", name: "Atlas" }];
    vi.spyOn(engine, "linkByPeer").mockImplementation(() => ({ peerPubKeyZ32: PEER, peerServices: shared }) as unknown as LinkView);
    const desktop = createDesktopHost("1.2.0") as unknown as Host;
    desktop.onServer({
      ready: Promise.resolve(),
      node: {
        request: async () => ({
          status: 404,
          headers: [["content-type", "text/plain; charset=utf-8"], ["x-ghostly-error", "unknown-service"]],
          bytes: async () => new TextEncoder().encode("This peer does not share that service.\n"),
        }),
      },
    });
    await vi.waitFor(() => expect(listeners.has("ghostly-svc-request")).toBe(true));
    await desktop.openService(PEER, "atlas", TAG);

    // The contact takes it back: their chat lists it no more, and the window's next page asks for it.
    shared = [];
    const request: ServiceRequest = { id: 7, peer: PEER, service: "atlas", method: "GET", path: "/", headers: [], body_b64: null };
    await listeners.get("ghostly-svc-request")!({ payload: request });
    const [, args] = called.mock.calls.find(([command]) => command === "service_respond")!;
    expect(page((args as { response: ServiceWindowResponse }).response)).toBe("Atlas is no longer shared with you.");
  });
});

describe("a Desktop viewer window opened while Hide my IP from contacts is on", () => {
  it("tells Rust, so the window's pages load nothing but their own origin; off, as before", async () => {
    // covers: settings.network.relay-only
    vi.spyOn(engine, "linkByPeer").mockImplementation(() => ({ peerPubKeyZ32: PEER, peerServices: [{ id: "atlas", name: "Atlas" }] }) as unknown as LinkView);
    const desktop = createDesktopHost("1.2.0") as unknown as Host;
    const opened = () => called.mock.calls.filter(([command]) => command === "open_service_window").map(([, args]) => (args as { relayOnly?: unknown }).relayOnly);
    called.mockClear();
    await desktop.openService(PEER, "atlas", TAG, true);
    await desktop.openService(PEER, "atlas", TAG, false);
    expect(opened()).toEqual([true, false]);
  });
});
