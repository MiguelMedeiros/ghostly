import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: transport.hyperdht, transport.native-pool

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: ((event: unknown) => void) | null }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class { onmessage: ((event: unknown) => void) | null = null; constructor() { tauri.channels.push(this); } },
}));

import { createHyperEndpoint } from "../../desktop/nativeTransports";

/** What Rust is asked while nothing happens, and how the page hears that an endpoint ended. */
describe("the Desktop's HyperDHT endpoints while idle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tauri.channels.length = 0;
    tauri.invoke.mockReset();
    let next = 0;
    tauri.invoke.mockImplementation(async (command: string) => command.endsWith("_start") ? { id: ++next, descriptor: { publicKey: "ab".repeat(32) } } : null);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("ask Rust nothing: eight of them make no call in a minute", async () => {
    const endpoints = await Promise.all(Array.from({ length: 8 }, () => createHyperEndpoint("c2VlZA")));
    tauri.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual([]);
    await Promise.all(endpoints.map((endpoint) => endpoint.close()));
  });

  it("are told by Rust that one ended, and its holder hears it at once", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    const unavailable = vi.fn();
    endpoint.onUnavailable = unavailable;
    tauri.channels[0].onmessage!({ type: "stopped" });
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("paired_hyperdht_stop", { endpointId: 1 });
    await expect(endpoint.connect({ publicKey: "cd".repeat(32) })).rejects.toThrow("Native endpoint is stopped");
    // Said twice, or after the holder closed it: nothing more.
    tauri.channels[0].onmessage!({ type: "stopped" });
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("tell a holder that starts listening after the endpoint ended", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    tauri.channels[0].onmessage!({ type: "stopped" });
    const unavailable = vi.fn();
    endpoint.onUnavailable = unavailable;
    expect(unavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("say nothing to a holder that closed its endpoint itself", async () => {
    const endpoint = await createHyperEndpoint("c2VlZA");
    const unavailable = vi.fn();
    endpoint.onUnavailable = unavailable;
    await endpoint.close();
    tauri.channels[0].onmessage!({ type: "stopped" });
    expect(unavailable).not.toHaveBeenCalled();
  });
});
