import { beforeEach, describe, expect, it, vi } from "vitest";

// covers: transport.iroh, settings.network.iroh-relays

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class { onmessage: unknown = null; },
}));

import { createHyperEndpoint, createIrohEndpoint } from "../../desktop/nativeTransports";

/**
 * The Desktop's own Iroh on the person's Iroh relays (WISP 102 § Relays): `paired_iroh_start` gets them, in the
 * spelling native Iroh names relays with; without any, nothing, and Rust homes the endpoint on its defaults.
 */
describe("the Desktop's Iroh endpoint and its relays", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command.endsWith("_start")) return { id: 1, descriptor: { id: "ab".repeat(32), relay: null, addresses: [] } };
      return null;
    });
  });

  it("passes the relays chosen to paired_iroh_start, dotted as native Iroh names them, and none otherwise", async () => {
    const chosen = await createIrohEndpoint("c2VlZA", { relays: ["https://relay.example.com/", "http://127.0.0.1:3340/"] });
    expect(tauri.invoke).toHaveBeenCalledWith("paired_iroh_start", expect.objectContaining({ seedB64: "c2VlZA", relays: ["https://relay.example.com./", "http://127.0.0.1:3340/"] }));
    await chosen.close();
    tauri.invoke.mockClear();
    const plain = await createIrohEndpoint("c2VlZA");
    expect(tauri.invoke.mock.calls.find(([command]) => command === "paired_iroh_start")?.[1]).not.toHaveProperty("relays");
    await plain.close();
  });

  it("gives HyperDHT no relays", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    expect(tauri.invoke.mock.calls.find(([command]) => command === "paired_hyperdht_start")?.[1]).not.toHaveProperty("relays");
    await endpoint.close();
  });
});
