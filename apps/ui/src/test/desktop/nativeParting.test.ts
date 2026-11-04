import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundChannel } from "@ghostly/core";

// covers: transport.hyperdht, transport.iroh

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: ((event: unknown) => void) | null }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class { onmessage: ((event: unknown) => void) | null = null; constructor() { tauri.channels.push(this); } },
}));

import { createHyperEndpoint, createIrohEndpoint } from "../../desktop/nativeTransports";

/** A contact's connection, as Rust opens it on the page. */
async function incoming(create: typeof createHyperEndpoint) {
  const endpoint = await create("c2VlZA");
  const connections: BoundChannel[] = [];
  endpoint.onConnection = (bound) => connections.push(bound);
  tauri.channels[0].onmessage!({ type: "open", id: 7, binding: { transport: "hyperdht/1", context: "aa", identities: [] }, incoming: true });
  return connections[0].channel;
}

const hangUp = "{\"t\":\"paired-call\",\"s\":\"{\\\"t\\\":\\\"h\\\",\\\"ts\\\":1700000000001}\"}";

describe("what the Desktop's native channels leave Rust to say as the app exits", () => {
  beforeEach(() => {
    tauri.channels.length = 0;
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => command.endsWith("_start") ? { id: 1, descriptor: { publicKey: "ab".repeat(32) } } : null);
  });

  it.each([
    ["HyperDHT", createHyperEndpoint, "paired_hyperdht_send", "paired_hyperdht_parting"],
    ["Iroh", createIrohEndpoint, "paired_native_send", "paired_native_parting"],
  ] as const)("%s's goes to Rust in order with the sends, only when it changed, and not once closed", async (_, create, send, parting) => {
    const channel = await incoming(create);
    channel.send("{\"t\":\"paired-call\",\"s\":\"offer\"}");
    channel.parting!(hangUp);
    channel.parting!(hangUp);
    channel.parting!(null);
    channel.parting!(null);
    const said = () => tauri.invoke.mock.calls.filter(([command]) => command === send || command === parting).map(([command, args]) => [command, args.text]);
    await vi.waitFor(() => expect(said()).toEqual([[send, "{\"t\":\"paired-call\",\"s\":\"offer\"}"], [parting, hangUp], [parting, null]]));
    expect(tauri.invoke.mock.calls.find(([command]) => command === parting)![1]).toEqual({ endpointId: 1, connectionId: 7, text: hangUp });

    channel.close();
    channel.parting!(hangUp);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(said()).toHaveLength(3);
  });
});
